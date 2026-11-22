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
  // Keep native IPC out of the static graph of owner-independent views. Those
  // views intentionally reject direct invoke imports, while still needing the
  // unified error normalizer and structured diagnostic logging.
  return import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<void>("logs_write", { entry: { ...entry, domain } }),
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 128)
    : "unknown";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error && typeof error === "object" && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  if (typeof error === "string") return error;
  return "Operation failed";
}

/** Stable severity for both UI diagnostics and persisted output. */
export function diagnosticLevel(error: unknown): LogLevel {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (
    (error instanceof Error && error.name === "AbortError") ||
    /(?:^|\.)(?:cancelled|canceled)$/i.test(message) ||
    message === "panel.window.cancelled"
  )
    return "debug";
  if (["database", "io", "internal", "ssh"].includes(code)) return "error";
  if (["validation", "notFound", "update"].includes(code)) return "warn";
  return error instanceof Error ? "error" : "warn";
}

const reported = new WeakSet<object>();
const reportedPrimitives = new Set<string>();

/** Best-effort diagnostics for failure paths. Never recurse on a failed log write.
 * Original code, message, structured-detail keys and stack are retained; native
 * logging redacts credential-like field names before writing the JSON log. */
export function reportError(
  domain: string,
  operation: string,
  error: unknown,
  level: LogLevel = diagnosticLevel(error),
): void {
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  } else {
    const identity = `${level}:${errorCode(error)}:${errorMessage(error)}`;
    if (reportedPrimitives.has(identity)) return;
    if (reportedPrimitives.size >= 1024) reportedPrimitives.clear();
    reportedPrimitives.add(identity);
  }
  const details =
    error && typeof error === "object" && "details" in error
      ? (error as { details?: unknown }).details
      : undefined;
  // Never persist even detail field names: plugin payloads may use a sensitive
  // key as a value-bearing field. The native logger independently redacts values.
  const detailCount =
    details && typeof details === "object" && !Array.isArray(details)
      ? Math.min(Object.keys(details).length, 32)
      : 0;
  const name =
    error instanceof Error
      ? error.name.slice(0, 128)
      : error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name ?? "").slice(0, 128)
        : "";
  const stack = error instanceof Error ? error.stack?.slice(0, 8192) : undefined;
  const normalizedOperation =
    operation.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "unknown";
  if (import.meta.env.MODE !== "test") {
    const log = level === "error" ? console.error : console.warn;
    log(`[${domain}:${normalizedOperation}] ${errorMessage(error)}`, { code: errorCode(error) });
  }
  void writeLog(domain, {
    level,
    message: errorMessage(error).slice(0, 4096),
    operation: normalizedOperation,
    fields: {
      code: errorCode(error),
      ...(name ? { name } : {}),
      ...(detailCount ? { detailCount } : {}),
      ...(stack ? { stack } : {}),
    },
  }).catch((failure) => {
    // One terminal console report is preferable to silently dropping the only
    // diagnostic when the native log writer itself is unavailable.
    if (import.meta.env.MODE !== "test") console.error("[diagnostics] log write failed", failure);
  });
}

/** Capture errors that escaped local handlers instead of leaving them only in
 * the WebView console. Safe to install once per document. */
export function installGlobalErrorDiagnostics(): () => void {
  if (typeof window === "undefined") return () => {};
  const onError = (event: ErrorEvent) => {
    reportError("runtime", "unhandledError", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportError("runtime", "unhandledRejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
