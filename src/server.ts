import { app } from "./app.js";
import { config } from "./config.js";

const server = app.listen(config.port, () => {
  console.log(`legwork-api listening on http://localhost:${config.port} (${config.nodeEnv})`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received, shutting down`);

  server.close((err) => {
    if (err) {
      console.error("Error while closing HTTP server:", err);
      process.exit(1);
    }
    process.exit(0);
  });

  // Do not hang forever on open connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
