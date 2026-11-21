/**
 * Error type for expected, client-facing failures.
 *
 * Anything thrown that is not an HttpError is treated as an unexpected
 * server error by the error handler in middleware/errorHandler.ts.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /**
   * Optional per-field messages. The save and submit routes use it so the
   * client can attach an error to the field that caused the failure while the
   * existing top-level message stays unchanged.
   */
  readonly errors: Record<string, string> | undefined;

  constructor(
    statusCode: number,
    message: string,
    code = "http_error",
    errors?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
  }
}
