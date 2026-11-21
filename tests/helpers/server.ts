import type { Server } from "node:http";
import express from "express";
import { customerAuthRouter } from "../../src/modules/customer/routes.js";
import { applicationsRouter } from "../../src/modules/applications/routes.js";
import { documentsRouter } from "../../src/modules/documents/routes.js";
import { catalogueRouter } from "../../src/modules/catalogue/routes.js";
import { requestsRouter } from "../../src/modules/requests/routes.js";
import { formsRouter } from "../../src/modules/forms/routes.js";
import { paymentsRouter } from "../../src/modules/payments/routes.js";
import { webhooksRouter } from "../../src/modules/webhooks/routes.js";
import {
  errorHandler,
  notFoundHandler,
} from "../../src/middleware/errorHandler.js";

// Keep the test app separate from src/app.ts, which opens the Redis-backed
// document queue at import time. Mount only the route groups used by suites.
let server: Server | null = null;
let baseUrl: string | null = null;

export async function startTestServer(): Promise<string> {
  if (baseUrl) {
    return baseUrl;
  }

  const app = express();

  app.use("/api/v1", webhooksRouter);
  // Only the public verify endpoint is exercised by the read endpoint suite.
  app.use("/api/v1", paymentsRouter);
  app.use("/api/v1/requests", express.json({ limit: "100kb" }));
  app.use("/api/v1", requestsRouter);
  app.use("/api/v1", catalogueRouter);
  // JSON parsing is scoped to the applicant routes (multipart uploads are left
  // untouched), and to the customer auth router: the Stripe webhook route needs
  // the untouched raw body, so a global express.json() would break it.
  app.use("/api/v1/applicants", express.json({ limit: "100kb" }));
  app.use("/api/v1", formsRouter);
  app.use("/api/v1", applicationsRouter);
  app.use("/api/v1", documentsRouter);
  app.use("/api/v1/auth", express.json({ limit: "100kb" }), customerAuthRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  const started = app.listen(0, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    started.once("listening", () => resolve());
    started.once("error", reject);
  });

  const address = started.address();

  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }

  server = started;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return baseUrl;
}

export function getBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("Test server is not running");
  }

  return baseUrl;
}

export async function closeTestServer(): Promise<void> {
  const current = server;

  if (!current) {
    return;
  }

  server = null;
  baseUrl = null;

  current.closeAllConnections();

  await new Promise<void>((resolve, reject) => {
    current.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/** POST a signed raw payload to the Stripe webhook route. */
export async function postStripeEvent(
  payload: string,
  signature: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${getBaseUrl()}/api/v1/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}
