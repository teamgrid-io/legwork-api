import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  startPendingScanSweep,
  type PendingScanSweep,
} from "../jobs/sweep-pending-scan.js";
import { documentScanWorker } from "./document-scan.worker.js";

console.log("Document scan worker started");

documentScanWorker.on("error", (error: Error) => {
  console.error(`Worker error: ${error.message}`);
});

let pendingScanSweep: PendingScanSweep | null = null;

if (config.nodeEnv === "test") {
  console.log("Pending scan sweep disabled in test mode");
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
}

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, closing document scan worker`);

  await documentScanWorker.close();

  if (pendingScanSweep) {
    await pendingScanSweep.worker.close();
    await pendingScanSweep.queue.close();
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
