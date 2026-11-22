import i18n from "@/i18n/i18n";
import { isIpcError } from "@/lib/api/types";
import { diagnosticLevel, reportError, type LogLevel } from "@/lib/diagnostics";
import { rememberErrorDetails } from "./errorDetails";

/** Stable application-facing failure contract shared by logs, UI state and
 * notifications. Raw details stay structured and are never flattened into the
 * localized title. */
export interface AppFailure {
  code: string;
  message: string;
  userMessage: string;
  severity: LogLevel;
  details: Record<string, unknown> | null;
  stack: string | null;
}

export interface ErrorContext {
  domain?: string;
  operation?: string;
  requestId?: string;
}

const CODE_KEYS: Record<string, string> = {
  validation: "error.validation",
  notFound: "error.notFound",
  database: "error.database",
  update: "error.update",
  io: "error.io",
  internal: "error.internal",
  ssh: "error.ssh",
};

type Translate = (key: string, options?: Record<string, unknown>) => string;
const translate = i18n.t.bind(i18n) as unknown as Translate;

function translateKey(key: string): string | null {
  if (i18n.exists(key)) {
    return translate(key);
  }
  return null;
}

export function normalizeError(error: unknown): AppFailure {
  const code = isIpcError(error) ? error.code : error instanceof Error ? "runtime" : "unknown";
  const message = isIpcError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : translate("error.generic");
  const translated = translateErrorDetailed(error);
  const generic = code in CODE_KEYS ? translate(CODE_KEYS[code]!) : null;
  const userMessage =
    generic && translated === generic && message && message !== generic && !i18n.exists(message)
      ? `${generic} · ${message}`
      : translated;
  return {
    code,
    message,
    userMessage,
    severity: diagnosticLevel(error),
    details:
      isIpcError(error) && error.details && typeof error.details === "object"
        ? error.details
        : null,
    stack: error instanceof Error && error.stack ? error.stack : null,
  };
}

/** Translate for presentation while retaining the original failure in the
 * structured diagnostic log and the matching toast's Details disclosure. */
export function translateError(error: unknown): string {
  return translateErrorWithContext(error);
}

/** Presentation translation with an explicit domain/operation. Existing call
 * sites can migrate incrementally while new code should use `notifyError`. */
export function translateErrorWithContext(error: unknown, context: ErrorContext = {}): string {
  const failure = normalizeError(error);
  reportError(
    context.domain ?? "ui",
    context.operation ?? "translateError",
    error,
    failure.severity,
  );
  // Inline callers get the same normalized failure without importing the UI
  // store. A later toast with this exact title claims the structured original.
  rememberErrorDetails(failure.userMessage, error);
  return failure.userMessage;
}

/** Human-readable, bounded representation used by notification details.
 * The full structured object remains available to diagnostics; this view only
 * avoids hiding the original code/message from the user. */
export function formatErrorDetails(error: unknown): string {
  const failure = normalizeError(error);
  return JSON.stringify(
    {
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
      ...(failure.stack ? { stack: failure.stack } : {}),
    },
    null,
    2,
  );
}

/** Normalize and log once. Presentation surfaces can then choose toast,
 * inline error, dialog or a custom renderer without duplicating diagnostics. */
export function captureError(error: unknown, context: ErrorContext = {}): AppFailure {
  const failure = normalizeError(error);
  reportError(context.domain ?? "ui", context.operation ?? "operation", error, failure.severity);
  rememberErrorDetails(failure.userMessage, error);
  return failure;
}

/** Default toast presentation of the unified failure contract. */
export async function notifyError(
  error: unknown,
  context: ErrorContext = {},
  options: { action?: { label: string; onClick: () => void | Promise<void> } } = {},
): Promise<AppFailure> {
  const failure = captureError(error, context);
  const { toast } = await import("@/store/toasts");
  toast(failure.userMessage, "error", options.action);
  return failure;
}

function translateErrorDetailed(error: unknown): string {
  if (isIpcError(error)) {
    const details = error.details;
    if (error.message === "plugin.activation.missingDependency" && typeof details?.id === "string")
      return translate("plugin.activation.missingDependencyDetails", { id: details.id });
    if (
      error.message === "plugin.activation.incompatibleDependency" &&
      details &&
      ["id", "required", "installed"].every((key) => typeof details[key] === "string")
    )
      return translate("plugin.activation.incompatibleDependencyDetails", details);
    if (
      error.message === "plugin.activation.cycle" &&
      Array.isArray(details?.chain) &&
      details.chain.every((item: unknown) => typeof item === "string")
    )
      return translate("plugin.activation.cycleDetails", { chain: details.chain.join(" → ") });
    if (error.message.startsWith("configuration.invalidValue:")) {
      return translate("configuration.invalidValue", {
        field: error.message.slice("configuration.invalidValue:".length),
      });
    }
    if (error.message.startsWith("preferences.invalidValue:")) {
      return translate("preferences.invalidValue", {
        field: error.message.slice("preferences.invalidValue:".length),
      });
    }
    if (error.message.startsWith("hostFields.invalidValue:")) {
      return translate("hostFields.invalidValue", {
        field: error.message.slice("hostFields.invalidValue:".length),
      });
    }
    if (
      error.message === "plugin.frontend.sdkUnsupported" &&
      typeof error.details?.required === "string" &&
      typeof error.details.available === "string"
    ) {
      return translate("plugin.frontend.sdkUnsupportedDetails", error.details);
    }
    if (error.code === "ssh" && error.details?.operation === "rename") {
      const details = error.details;
      if (["from", "to", "reason"].every((key) => typeof details[key] === "string")) {
        const serverMessage =
          typeof details.serverMessage === "string" ? details.serverMessage.trim() : "";
        const unspecified =
          details.statusCode === 4 &&
          (!serverMessage || /^failure(?::\s*failure)?$/i.test(serverMessage));
        const reason = unspecified
          ? translate("sftp.renameServerFailure")
          : typeof details.statusCode === "number" && serverMessage
            ? translate("sftp.renameStatusReason", {
                statusCode: details.statusCode,
                reason: serverMessage,
              })
            : String(details.reason).startsWith("sftp.")
              ? translateErrorDetailed({ code: "ssh", message: String(details.reason) })
              : String(details.reason);
        return translate("sftp.renameFailed", { from: details.from, to: details.to, reason });
      }
    }
    if (error.message === "plugin.engine.unsupported") {
      const details = error.details;
      if (
        details &&
        ["hostVersion", "pluginVersion", "required"].every(
          (key) => typeof details[key] === "string",
        )
      ) {
        return translate("pluginErrors.hostVersionMismatch", {
          hostVersion: details.hostVersion,
          pluginVersion: details.pluginVersion,
          required: details.required,
        });
      }
      return translate("pluginErrors.hostVersionUnsupported");
    }
    if (error.message.startsWith("ssh.error:")) {
      return error.message.slice("ssh.error:".length).trim();
    }
    if (error.message.startsWith("plugin.error:")) {
      return error.message.slice("plugin.error:".length).trim() || translate("error.generic");
    }
    if (error.message.startsWith("plugin.runners.commandFailed:")) {
      return translate("plugin.runners.commandFailed", {
        reason:
          error.message.slice("plugin.runners.commandFailed:".length).trim() ||
          translate("plugin.runners.noCommandDetails"),
      });
    }
    // SFTP wraps transport/protocol details; do not reduce every failure to
    // "SSH error", which prevents users from distinguishing reconnection,
    // permission and server failures.
    if (/^sftp\.(error|channel|subsystem):/.test(error.message)) {
      const detail = error.message.slice(error.message.indexOf(":") + 1).trim();
      if (/^sftp\.error:/.test(error.message) && /^failure:\s*failure$/i.test(detail))
        return translate("sftp.serverUnspecifiedFailure");
      return detail || translate("error.ssh");
    }
    const known = translateKey(error.message);
    if (known) {
      return known;
    }
    const codeKey = CODE_KEYS[error.code];
    if (codeKey) {
      const generic = translate(codeKey);
      // An unrecognized backend key is actionable detail; append it rather
      // than reducing every validation failure to the generic field prompt.
      return error.message && error.message !== generic ? `${generic} · ${error.message}` : generic;
    }
    return error.message;
  }
  if (error instanceof Error) {
    return translateKey(error.message) ?? error.message;
  }
  return translate("error.generic");
}
