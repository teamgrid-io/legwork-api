import { Job, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditLogs, documents } from "../db/schema.js";
import { createWorkerConnection } from "../lib/queue.js";
import { scanner } from "../lib/scanner.js";
import { storage } from "../lib/storage.js";

interface DocumentScanJobData {
  documentId: string;
}

async function processDocumentScan(
  job: Job<DocumentScanJobData>,
): Promise<void> {
  const documentId = job.data.documentId;

  const [document] = await db
    .select({
      id: documents.id,
      status: documents.status,
      storageKey: documents.storageKey,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!document) {
    console.log(`Document not found: ${documentId}`);
    return;
  }

  if (document.status !== "pending_scan") {
    console.log(`Document skipped: ${documentId}`);
    return;
  }

  // A read failure or a scanner failure must throw so BullMQ retries the job;
  // neither is a reason to reject the document.
  const data = await storage.get(document.storageKey);
  const result = await scanner.scan(data);

  const status = result.clean ? "verified" : "rejected";

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(documents)
      .set({
        status,
        rejectionReason: result.clean ? null : (result.reason ?? null),
      })
      .where(
        and(
          eq(documents.id, document.id),
          eq(documents.status, "pending_scan"),
        ),
      )
      .returning({ id: documents.id });

    if (!row) {
      return false;
    }

    await tx.insert(auditLogs).values({
      actorType: "system",
      action: "document.scanned",
      entityType: "document",
      entityId: document.id,
      metadata: { result: status },
    });

    return true;
  });

  if (!updated) {
    console.log(`Document skipped: ${documentId}`);
  }
}

export const documentScanWorker = new Worker<DocumentScanJobData>(
  "document-scan",
  processDocumentScan,
  { connection: createWorkerConnection() },
);

documentScanWorker.on("failed", (job, error) => {
  if (!job) {
    return;
  }

  const attempts = job.opts.attempts ?? 1;

  if (job.attemptsMade >= attempts) {
    console.error(
      `Scan permanently failed: ${job.data.documentId}: ${error.message}`,
    );
  }
});
