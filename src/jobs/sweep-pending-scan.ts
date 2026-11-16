import { Queue, Worker } from "bullmq";
import { and, asc, eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { createWorkerConnection, enqueueDocumentScan } from "../lib/queue.js";

// A document stuck in "pending_scan" is one whose upload committed but whose
// enqueue call failed (the API answered 503). The sweep finds those rows and
// re-queues them with the same helper the upload route uses, so the job id
// (`scan-<documentId>`) stays identical and a second run cannot duplicate work.
const SWEEP_QUEUE_NAME = "document-scan-sweep";
const SWEEP_JOB_NAME = "sweep-pending-scan";
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_AFTER_MS = 10 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * Re-queue documents that have been pending_scan for longer than the
 * threshold. Returns how many were successfully enqueued.
 */
export async function sweepPendingScans(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);

  // `documents` has no updated_at column; uploaded_at is the moment the row
  // entered pending_scan, so it is the age that matters here.
  const stuck = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.status, "pending_scan"),
        lt(documents.uploadedAt, cutoff),
      ),
    )
    .orderBy(asc(documents.uploadedAt))
    .limit(BATCH_SIZE);

  let requeued = 0;

  for (const document of stuck) {
    try {
      await enqueueDocumentScan(document.id);
      requeued += 1;
    } catch (error) {
      // Keep sweeping the rest of the batch when Redis is unavailable.
      console.error(
        `Pending scan sweep: failed to re-queue document ${document.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    `Pending scan sweep: ${stuck.length} found, ${requeued} re-queued`,
  );

  return requeued;
}

export interface PendingScanSweep {
  readonly queue: Queue;
  readonly worker: Worker;
}

/**
 * Create the sweep queue, register the repeatable job (idempotent upsert) and
 * start the worker that runs the sweep. Call once, from the worker entrypoint.
 */
export async function startPendingScanSweep(): Promise<PendingScanSweep> {
  const queue = new Queue(SWEEP_QUEUE_NAME, {
    connection: createWorkerConnection(),
  });

  await queue.upsertJobScheduler(
    SWEEP_JOB_NAME,
    { every: SWEEP_INTERVAL_MS },
    {
      name: SWEEP_JOB_NAME,
      data: {},
      opts: {
        removeOnComplete: true,
        removeOnFail: { age: 604800 },
      },
    },
  );

  const worker = new Worker(
    SWEEP_QUEUE_NAME,
    async (): Promise<void> => {
      await sweepPendingScans();
    },
    {
      connection: createWorkerConnection(),
      concurrency: 1,
    },
  );

  worker.on("error", (error: Error) => {
    console.error(`Pending scan sweep worker error: ${error.message}`);
  });

  worker.on("failed", (_job, error: Error) => {
    console.error(`Pending scan sweep failed: ${error.message}`);
  });

  console.log(
    `Pending scan sweep scheduled every ${SWEEP_INTERVAL_MS / 60000} minutes`,
  );

  return { queue, worker };
}
