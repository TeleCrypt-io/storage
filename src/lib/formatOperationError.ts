import { formatDiagnosticError } from "./errorDetails";

/**
 * The SDK owns its user-facing StorageError messages, including whether a mutation may
 * have completed. Other failures retain their complete error and cause details after
 * credential redaction and control-character escaping. This function never truncates or
 * replaces a diagnostic with a generic message merely because it is large or unfamiliar.
 */
export function formatOperationError(err: unknown): string {
  const detail = formatDiagnosticError(err);
  return detail === "undefined" || detail === "null" || detail === "" ? "Operation failed" : detail;
}
