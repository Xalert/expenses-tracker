export type ServiceErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

/**
 * Thrown by the service layer (`src/server/*`). `message` is safe to show to the user.
 * `field` optionally names the form field the error belongs to (e.g. "amount", "walletId").
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly field?: string;

  constructor(code: ServiceErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.field = field;
  }
}

export function isServiceError(err: unknown): err is ServiceError {
  return err instanceof ServiceError;
}
