export class CliError extends Error {
  constructor(
    message,
    { exitCode = 1, details = undefined, code = undefined } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
    this.code = code ?? details?.code;
  }
}

export class ApiError extends CliError {
  constructor(message, { status, code, retryAfter, body } = {}) {
    const exitCode =
      status === 401 || status === 403
        ? 4
        : status === 409
          ? 5
          : status === 429 || status === 503
            ? 3
            : 1;
    super(message, { exitCode, details: body });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

export function toErrorMessage(error) {
  if (error instanceof ApiError) {
    const label = [error.status, error.code].filter(Boolean).join(" ");
    return `WarpMetal API ${label}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
