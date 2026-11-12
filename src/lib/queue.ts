import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

// One shared connection for this process. BullMQ requires
// maxRetriesPerRequest: null so commands wait for the reconnect instead of
// failing while Redis is unavailable.
const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

connection.on("error", (error: Error) => {
  // Only the error itself is logged; the redis URL is never printed.
  console.error(`Redis connection error: ${error.message}`);
});

export const documentScanQueue = new Queue("document-scan", { connection });

export async function enqueueDocumentScan(documentId: string): Promise<void> {
  await documentScanQueue.add(
    "scan",
    { documentId },
    {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: true,
    },
  );
}
