import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  startPendingScanSweep,
  type PendingScanSweep,
} from "../jobs/sweep-pending-scan.js";
import {
  startStripeWebhookEventSweep,
  type StripeWebhookEventSweep,
} from "../jobs/start-stripe-webhook-event-sweep.js";
import { documentScanWorker } from "./document-scan.worker.js";

console.log("Document scan worker started");

documentScanWorker.on("error", (error: Error) => {
  console.error(`Worker error: ${error.message}`);
});

let pendingScanSweep: PendingScanSweep | null = null;
let stripeWebhookEventSweep: StripeWebhookEventSweep | null = null;

if (config.nodeEnv === "test") {
  console.log("Pending scan sweep disabled in test mode");
  console.log("Stripe webhook sweep disabled in test mode");
} else {
  void startPendingScanSweep()
    .then((sweep) => {
      pendingScanSweep = sweep;
    })
    .catch((error: unknown) => {
      console.error(
        `Pending scan sweep could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

  void startStripeWebhookEventSweep()
    .then((sweep) => {
      stripeWebhookEventSweep = sweep;
    })
    .catch(() => {
      console.error("Stripe webhook sweep could not start");
    });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, closing document scan worker`);

  await documentScanWorker.close();

  if (pendingScanSweep) {
    await pendingScanSweep.worker.close();
    await pendingScanSweep.queue.close();
  }

  if (stripeWebhookEventSweep) {
    await stripeWebhookEventSweep.worker.close();
    await stripeWebhookEventSweep.queue.close();
  }

  await pool.end();

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
