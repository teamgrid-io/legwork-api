import { pool } from "../db/pool.js";
import { documentScanWorker } from "./document-scan.worker.js";

console.log("Document scan worker started");

documentScanWorker.on("error", (error: Error) => {
  console.error(`Worker error: ${error.message}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, closing document scan worker`);

  await documentScanWorker.close();
  await pool.end();

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
