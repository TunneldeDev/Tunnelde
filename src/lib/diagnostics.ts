import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };
export interface LogEntry {
  message: string;
  level?: LogLevel;
  operation?: string;
  requestId?: string;
  fields?: Record<string, LogValue>;
}

/** Write through the host's local rotating log. The host prefixes frontend domains,
 * validates bounds and redacts structured credential fields. Never log secrets or
 * document contents in message text. Resolution means accepted, not durable fsync.
 */
export function writeLog(domain: string, entry: LogEntry): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return Promise.resolve();
  return invoke<void>("logs_write", { entry: { ...entry, domain } });
}

/** Best-effort diagnostics for failure paths. Never recurse on a failed log write. */
export function reportError(domain: string, operation: string, error: unknown): void {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Operation failed";
  void writeLog(domain, {
    level: "error",
    message: message.slice(0, 4096),
    operation: operation.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "unknown",
    fields: { code },
  }).catch(() => {
    /* A logging failure must not cause another logging request. */
  });
}
