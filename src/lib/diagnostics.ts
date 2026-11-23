export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };
export interface LogEntry {
  message: string;
  level?: LogLevel;
  operation?: string;
  requestId?: string;
  fields?: Record<string, LogValue>;
}

function nativeAvailable() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Explicitly authored log messages. Callers must supply only safe data. */
export function writeLog(domain: string, entry: LogEntry): Promise<void> {
  if (!nativeAvailable()) return Promise.resolve();
  return import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<void>("logs_write", { entry: { ...entry, domain } }),
  );
}

function property(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  } catch {
    // Rejected values can be proxies or have throwing getters.
    return undefined;
  }
}

function stringProperty(value: unknown, key: string): string {
  const result = property(value, key);
  return typeof result === "string" ? result : "";
}

const CODES = new Set(["validation", "notFound", "update", "io", "internal", "database", "ssh"]);
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "AbortError",
]);

function errorCode(error: unknown): string {
  const code = stringProperty(error, "code");
  if (CODES.has(code)) return code;
  return ERROR_NAMES.has(stringProperty(error, "name")) ? "runtime" : "unknown";
}

export function diagnosticLevel(error: unknown): LogLevel {
  const code = errorCode(error);
  const message = typeof error === "string" ? error : stringProperty(error, "message");
  if (
    stringProperty(error, "name") === "AbortError" ||
    /(?:^|\.)(?:cancelled|canceled)$/i.test(message)
  )
    return "debug";
  if (["database", "io", "internal", "ssh", "runtime"].includes(code)) return "error";
  return "warn";
}

const identifier = (value: string) =>
  value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "unknown";

// Arbitrary exception text can contain data supplied by the user or a server.
const SAFE_MESSAGES = new Set([
  "panel.viewState.duplicateKey",
  "panel.viewState.identityChanged",
  "panel.viewState.invalid",
  "panel.viewState.invalidKey",
  "panel.viewState.tooLarge",
  "panel.viewState.tooManyFields",
  "panel.window.viewNotReady",
  "panel.window.staleOwner",
  "panel.window.cancelled",
  "plugin.frontend.viewUnavailable",
  "host.name.required",
  "logs.diagnosticReadFailed",
  "logs.operationsReadFailed",
  "fonts.loadFailed",
  "diagnostics.recovered",
  "diagnostics.clipboardUnavailable",
  "terminal.checkpointBusy",
  "updates.sourcesUnavailable",
]);

function safeFrames(stack: string): string[] {
  const frames: string[] = [];
  const trustedOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const applicationSources = new Set([
    trustedOrigin,
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);
  for (const raw of stack.slice(0, 32768).split("\n")) {
    const line = raw.trim();
    // Ignore the exception headline and arbitrary text, even if it resembles
    // a source path. Chromium and React use "at"; WebKit uses "name@source".
    if (!/^(?:at\s|[^\s@:]*@)/.test(line)) continue;
    // Retain only application source coordinates. Drop arbitrary function names,
    // external URLs, absolute paths, surrounding text, queries and fragments.
    const frame =
      /(?:^|[/@\s(])((?:src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.[cm]?[jt]sx?|assets\/[a-zA-Z0-9_-]+\.js))(?:[?#][^\s)]*)?:(\d{1,7}):(\d{1,7})\)?$/.exec(
        line,
      );
    const origin = /[a-z][a-z+.-]*:\/\/[^/ )]+/i.exec(line)?.[0];
    if (
      origin ? !applicationSources.has(origin) : !/(?:^|[@\s(])(?:src|assets)\//.test(line.trim())
    )
      continue;
    if (frame && frame[1]!.length <= 220) frames.push(`${frame[1]}:${frame[2]}:${frame[3]}`);
    if (frames.length === 12) break;
  }
  return frames;
}

export interface DiagnosticEvent {
  eventId: string;
  timestamp: string;
  domain: string;
  operation: string;
  level: LogLevel;
  code: string;
  message: string;
  requestId?: string;
  frames: string[];
  occurrences?: number;
}

type Delivery = "pending" | "accepted" | "memory";
interface LocalDiagnostic {
  event: DiagnosticEvent;
  delivery: Delivery;
}
const byError = new WeakMap<object, { event: DiagnosticEvent; at: number }>();
const listeners = new Set<() => void>();
let localDiagnostics: readonly LocalDiagnostic[] = [];

export function clearLocalDiagnostics() {
  localDiagnostics = [];
  for (const notify of listeners) notify();
}
const LOCAL_LIMIT = 100;
const IPC_LIMIT = 16;
let writesInFlight = 0;
let sequence = 0;
const fallbackPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function publish(event: DiagnosticEvent, delivery: Delivery) {
  const current = localDiagnostics.find((row) => row.event.eventId === event.eventId);
  // A late reply must not revive an evicted pending entry.
  if (delivery !== "pending" && !current) return;
  localDiagnostics = current
    ? localDiagnostics.map((row) => (row === current ? { event, delivery } : row))
    : [...localDiagnostics, { event, delivery }].slice(-LOCAL_LIMIT);
  for (const notify of listeners) notify();
}

export const getLocalDiagnostics = () => localDiagnostics;
export function subscribeLocalDiagnostics(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

export function reportError(
  domain: string,
  operation: string,
  error: unknown,
  level = diagnosticLevel(error),
  context: { requestId?: string; occurrences?: number; componentStack?: string } = {},
): DiagnosticEvent {
  const now = Date.now();
  const object = error && typeof error === "object" ? error : undefined;
  const previous = object ? byError.get(object) : undefined;
  if (previous && now - previous.at < 1000) return previous.event;
  const rawMessage = typeof error === "string" ? error : stringProperty(error, "message");
  const name = stringProperty(error, "name");
  const event: DiagnosticEvent = {
    eventId: globalThis.crypto?.randomUUID?.() ?? `${fallbackPrefix}-${++sequence}`,
    timestamp: new Date(now).toISOString(),
    domain: identifier(domain),
    operation: identifier(operation),
    level,
    code: errorCode(error),
    message: SAFE_MESSAGES.has(rawMessage)
      ? rawMessage
      : ERROR_NAMES.has(name)
        ? name
        : "Operation failed",
    frames: safeFrames([stringProperty(error, "stack"), context.componentStack].join("\n")),
    ...(context.requestId ? { requestId: identifier(context.requestId) } : {}),
    ...(context.occurrences && context.occurrences > 1 ? { occurrences: context.occurrences } : {}),
  };
  if (object) byError.set(object, { event, at: now });
  // Keep a local copy for the error details while the host accepts the event.
  publish(event, "pending");
  if (import.meta.env.MODE !== "test") {
    // eslint-disable-next-line no-console
    const log = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
    log(`[${event.eventId}] ${event.domain}.${event.operation}: ${event.message}`, event);
  }
  const fallback = () => publish(event, "memory");
  if (!nativeAvailable() || writesInFlight >= IPC_LIMIT) fallback();
  else {
    writesInFlight++;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      fallback();
    }, 3000);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("diagnostics_report", { event }))
      .then((accepted) => publish(event, accepted ? "accepted" : "memory"))
      .catch(() => {
        if (!timedOut) fallback();
      })
      .finally(() => {
        clearTimeout(timer);
        writesInFlight--;
      });
  }
  return event;
}

/** Rate-limit repeated polling failures within an outage. On recovery, report
 * the total observed count, including failures suppressed between samples. */
export function createDiagnosticSampler(domain: string, operation: string, intervalMs = 30000) {
  let last = -Infinity;
  let count = 0;
  return {
    failed(error: unknown) {
      count++;
      const now = Date.now();
      if (now - last < intervalMs) return;
      last = now;
      reportError(domain, operation, error, diagnosticLevel(error), { occurrences: count });
    },
    recovered() {
      if (count > 1) {
        reportError(domain, `${operation}.recovered`, new Error("diagnostics.recovered"), "info", {
          occurrences: count,
        });
      }
      count = 0;
      last = -Infinity;
    },
  };
}

let uninstall: (() => void) | undefined;
export function installGlobalErrorDiagnostics(): () => void {
  if (uninstall) return uninstall;
  if (typeof window === "undefined") return () => {};
  const onError = (event: ErrorEvent) => {
    reportError("runtime", "unhandledError", event.error ?? event.message, "error");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportError("runtime", "unhandledRejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  uninstall = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    uninstall = undefined;
  };
  return uninstall;
}
