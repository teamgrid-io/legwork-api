import { Queue, Worker } from "bullmq";
import { createWorkerConnection } from "../lib/queue.js";
import { sweepStaleStripeEvents } from "./sweep-stripe-webhook-events.js";

const SWEEP_QUEUE_NAME = "stripe-webhook-event-sweep";
const SWEEP_JOB_NAME = "sweep-stripe-webhook-events";
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface StripeWebhookEventSweep {
  readonly queue: Queue;
  readonly worker: Worker;
}

/**
 * Create the sweep queue, register the repeatable job (idempotent upsert) and
 * start the worker that runs the sweep. Call once, from the worker entrypoint.
 */
export async function startStripeWebhookEventSweep(): Promise<StripeWebhookEventSweep> {
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
      await sweepStaleStripeEvents();
    },
    {
      connection: createWorkerConnection(),
      concurrency: 1,
    },
  );

  // Fixed strings only: BullMQ and ioredis errors can carry connection details,
  // so nothing from the error object is logged.
  worker.on("error", () => {
    console.error("Stripe webhook sweep worker error");
  });

  worker.on("failed", () => {
    console.error("Stripe webhook sweep failed");
  });

  console.log("Stripe webhook sweep scheduled every 5 minutes");

  return { queue, worker };
}
