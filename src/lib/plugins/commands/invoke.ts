import { isPluginInvocationCancelled, samePluginRuntime } from "./runtime";
import type { PluginInfo } from "@/lib/api/types";
import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { usePlugins } from "@/store/plugins";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { useWorkspace } from "@/store/workspace";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";
import { normalizeResult } from "../pluginView";
import { samePluginAction, type PluginActionTarget } from "./identity";

/** execute() owns permission consent; the input factory checks the selected package afterwards. */
export async function invokeContributedCommand(
  original: PluginInfo,
  action: PluginActionTarget,
  signal?: AbortSignal,
) {
  const current = () => {
    const plugin = usePlugins.getState().items.find((item) => item.id === original.id);
    if (!samePluginAction(plugin, original, action) || plugin.status !== "running")
      throw new Error("pluginSecurity.changed");
    return plugin;
  };
  try {
    if (signal?.aborted) return;
    current();
    const running = current();
    const result = await usePlugins.getState().execute(
      original.id,
      action.command!,
      () => {
        current();
        return { _locale: i18n.resolvedLanguage ?? i18n.language };
      },
      signal,
    );
    const plugin = current(),
      security = usePluginSecurity.getState().state;
    if (signal?.aborted || !samePluginRuntime(plugin, running)) return;
    if (isTauri() && (security.restricted || !hasPluginGrant(security, plugin))) return;
    const output = normalizeResult(result);
    usePlugins.setState((state) => ({
      outputs: { ...state.outputs, [plugin.id]: { text: output.text, error: output.error } },
    }));
    useWorkspace.getState().openPluginView(plugin.id, "$command", plugin.name);
  } catch (error) {
    if (isPluginInvocationCancelled(error)) return;
    if (error instanceof Error && error.message === "plugin.permissionDenied") return;
    toast(
      error instanceof Error && error.message === "resultTooLarge"
        ? i18n.t("pluginView.resultTooLarge")
        : translateError(error),
      "error",
    );
  }
}
