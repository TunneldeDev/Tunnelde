import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";
import { isIpcError } from "@/lib/api/types";

/** Plugin state events store strings, while rejected IPC calls carry error objects. */
export function pluginFailure(error: unknown): string {
  let message = isIpcError(error) ? error.message : error instanceof Error ? error.message : "";
  if (message.startsWith("plugin.error: ")) message = message.slice("plugin.error: ".length);
  if (message === "plugin exited" || message === "plugin.exited")
    return i18n.t("pluginErrors.exited");
  if (message.startsWith("plugin.spawn: "))
    return `${i18n.t("pluginErrors.spawn")}: ${message.slice("plugin.spawn: ".length)}`;
  if (message.startsWith("plugin.write: "))
    return `${i18n.t("pluginErrors.write")}: ${message.slice("plugin.write: ".length)}`;
  if (message === "plugin.timeout") return i18n.t("pluginErrors.timeout");
  if (!message) return translateError(error);
  // Recreate the structured error for localization keys delivered through status events.
  const translated = translateError({ code: "validation", message });
  return translated === i18n.t("error.validation") ? message : translated;
}
