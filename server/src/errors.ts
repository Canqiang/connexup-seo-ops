/** Typed API error. Routes/services throw these; a global handler renders
 * the `{message, error_code?}` body the frontend expects. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string, code = "STALE_STATE"): ApiError {
  return new ApiError(409, message, code);
}
