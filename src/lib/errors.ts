/**
 * Error type for expected, client-facing failures.
 *
 * Anything thrown that is not an HttpError is treated as an unexpected
 * server error by the error handler in middleware/errorHandler.ts.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code = "http_error") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
