import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

// Producer connection: fail fast when Redis is unavailable instead of
// buffering commands forever. The API turns the resulting error into a 503.
const producerConnection = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

producerConnection.on("error", (error: Error) => {
  // Only the error itself is logged; the redis URL is never printed.
  console.error(`Redis connection error: ${error.message}`);
});

export const documentScanQueue = new Queue("document-scan", {
  connection: producerConnection,
});

export async function enqueueDocumentScan(documentId: string): Promise<void> {
  await documentScanQueue.add(
    "scan",
    { documentId },
    {
      jobId: `scan-${documentId}`,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: { age: 604800 },
    },
  );
}

// Workers require maxRetriesPerRequest: null. Every call returns a new
// connection so the producer and the worker never share one.
export function createWorkerConnection(): Redis {
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });

  connection.on("error", (error: Error) => {
    // Only the error itself is logged; the redis URL is never printed.
    console.error(`Redis connection error: ${error.message}`);
  });

  return connection;
}
