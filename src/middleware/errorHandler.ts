import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/errors.js";

/**
 * Unknown route -> JSON 404 instead of Express' HTML default.
 */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found", code: "not_found" });
};

/**
 * Central error handler. Every response uses { error, code }.
 *
 * Internal details (stack traces, Zod issues) are logged or discarded on the
 * server and never sent to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }

  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ error: "Invalid request data", code: "validation_error" });
    return;
  }

  // Malformed JSON body from express.json().
  if (err instanceof SyntaxError && "body" in err) {
    res
      .status(400)
      .json({ error: "Invalid request data", code: "validation_error" });
    return;
  }

  console.error("Unhandled error:", err);
  res
    .status(500)
    .json({ error: "Something went wrong", code: "internal_error" });
};
