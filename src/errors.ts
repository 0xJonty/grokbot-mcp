import { redact } from "./log.ts";

export type ErrorCode =
  | "signed_out"
  | "not_installed"
  | "auth"
  | "decrypt"
  | "route"
  | "backend"
  | "gateway"
  | "not_found"
  | "ambiguous"
  | "invalid"
  | "stale"
  | "delivery_unknown"
  | "timeout";

/** User-facing error. `message` must be short, actionable and secret-free. */
export class GrokError extends Error {
  code: ErrorCode;
  status?: number;
  constructor(code: ErrorCode, message: string, status?: number) {
    super(redact(message));
    this.name = "GrokError";
    this.code = code;
    this.status = status;
  }
}

export function errorText(err: unknown): string {
  if (err instanceof GrokError) return err.message;
  return "Unexpected error: " + redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
}
