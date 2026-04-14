export class ChorusError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly integration?: string;
  readonly operation?: string;
  readonly originalCause?: unknown;

  constructor(opts: {
    code: string;
    message: string;
    httpStatus?: number;
    retryable?: boolean;
    integration?: string;
    operation?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "ChorusError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable ?? false;
    this.integration = opts.integration;
    this.operation = opts.operation;
    this.originalCause = opts.cause;
  }
}

export class IntegrationError extends ChorusError {
  constructor(opts: Omit<ConstructorParameters<typeof ChorusError>[0], "code"> & { code?: string }) {
    super({ code: opts.code ?? "INTEGRATION_ERROR", ...opts });
    this.name = "IntegrationError";
  }
}

export class AuthError extends ChorusError {
  constructor(opts: Omit<ConstructorParameters<typeof ChorusError>[0], "code" | "retryable">) {
    super({ code: "AUTH_ERROR", retryable: false, ...opts });
    this.name = "AuthError";
  }
}

export class RateLimitError extends ChorusError {
  readonly retryAfterMs?: number;
  constructor(opts: Omit<ConstructorParameters<typeof ChorusError>[0], "code" | "retryable"> & {
    retryAfterMs?: number;
  }) {
    super({ code: "RATE_LIMIT", retryable: true, ...opts });
    this.name = "RateLimitError";
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class SchemaDriftError extends ChorusError {
  readonly expected: unknown;
  readonly actual: unknown;
  constructor(opts: Omit<ConstructorParameters<typeof ChorusError>[0], "code" | "retryable"> & {
    expected: unknown;
    actual: unknown;
  }) {
    super({ code: "SCHEMA_DRIFT", retryable: false, ...opts });
    this.name = "SchemaDriftError";
    this.expected = opts.expected;
    this.actual = opts.actual;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ChorusError) return err.retryable;
  if (err instanceof Error && /ECONN|ETIMEDOUT|ENOTFOUND|socket hang up/.test(err.message)) return true;
  return false;
}
