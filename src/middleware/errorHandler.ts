import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
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
    const body: {
      error: string;
      code: string;
      errors?: Record<string, string>;
    } = { error: err.message, code: err.code };

    if (err.errors) {
      body.errors = err.errors;
    }

    res.status(err.statusCode).json(body);
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

  // Multer rejects the multipart body before the controller runs. These are
  // client errors, so they are not logged and never reach the 500 fallback.
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "Invalid file size", code: "http_error" });
      return;
    }

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
