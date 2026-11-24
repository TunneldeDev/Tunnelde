import i18n from "@/i18n/i18n";

type Translate = (key: string) => string;
const translateKey = i18n.t.bind(i18n) as unknown as Translate;
import { presentError } from "@/lib/api/errors";
import { isIpcError } from "@/lib/api/types";

/** Plugin state events store strings, while rejected IPC calls carry error objects. */
export function pluginFailure(error: unknown): string {
  const message = formatFailure(error);
  const context = isIpcError(error) ? error.details?.activation : null;
  if (
    context &&
    typeof context === "object" &&
    "pluginId" in context &&
    typeof context.pluginId === "string"
  )
    return i18n.t("pluginErrors.packageFailure", { pluginId: context.pluginId, error: message });
  return message;
}

function formatFailure(error: unknown): string {
  const rawMessage = isIpcError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : "";
  let message = rawMessage;
  if (message.startsWith("plugin.error: ")) message = message.slice("plugin.error: ".length);
  if (message.startsWith("plugin.error:")) message = message.slice("plugin.error:".length).trim();
  if (message.startsWith("plugin.api.frontend:"))
    message = message.slice("plugin.api.frontend:".length);
  if (message === "plugin exited" || message === "plugin.exited")
    return i18n.t("pluginErrors.exited");
  if (message.startsWith("plugin.spawn: "))
    return `${i18n.t("pluginErrors.spawn")}: ${message.slice("plugin.spawn: ".length)}`;
  if (message.startsWith("plugin.write: "))
    return `${i18n.t("pluginErrors.write")}: ${message.slice("plugin.write: ".length)}`;
  if (message === "plugin.timeout") return i18n.t("pluginErrors.timeout");
  if (!message) return presentError(error);
  if (message === "plugin.engine.unsupported" || message === "plugin.frontend.sdkUnsupported")
    return presentError(isIpcError(error) ? error : { code: "validation", message });
  // Recreate the structured error for localization keys delivered through status events.
  // A bare plugin runtime message is already the most specific user-facing
  // diagnosis; do not prefix the generic field-validation category.
  if (rawMessage.startsWith("plugin.error:")) {
    presentError(error);
    return i18n.exists(message) ? translateKey(message) : message;
  }
  const translated = presentError(
    isIpcError(error) ? { ...error, message } : { code: "validation", message },
  );
  return translated === i18n.t("error.validation") ? message : translated;
}
