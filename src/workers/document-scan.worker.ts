import { Job, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { auditLogs, documents } from "../db/schema.js";
import { scanner } from "../lib/scanner.js";
import { storage } from "../lib/storage.js";

interface DocumentScanJobData {
  documentId: string;
}

async function processDocumentScan(job: Job<DocumentScanJobData>): Promise<void> {
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

  const result = await scanner.scan(storage.path(document.storageKey));

  const status = result.clean ? "verified" : "rejected";

  await db
    .update(documents)
    .set({
      status,
      rejectionReason: result.clean ? null : (result.reason ?? null),
    })
    .where(eq(documents.id, document.id));

  await db.insert(auditLogs).values({
    actorType: "system",
    action: "document.scanned",
    entityType: "document",
    entityId: document.id,
    metadata: { result: status },
  });
}

const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

connection.on("error", (error: Error) => {
  // Only the error itself is logged; the redis URL is never printed.
  console.error(`Redis connection error: ${error.message}`);
});

export const documentScanWorker = new Worker<DocumentScanJobData>(
  "document-scan",
  processDocumentScan,
  { connection },
);
