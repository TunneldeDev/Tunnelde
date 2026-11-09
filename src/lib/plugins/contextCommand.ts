import type { PluginInfo } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { isTauri } from "@/lib/api/ipc";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";
import { normalizeResult } from "./pluginView";
import i18n from "@/i18n/i18n";

export interface PluginContextCommand {
  pluginId: string;
  pluginName: string;
  command: string;
  title: string;
  fingerprint?: string;
  first: boolean;
}

/** Shared consent, stale-target checks and output handling for user-selected resources. */
export async function runPluginContextCommand(
  action: PluginContextCommand,
  context: {
    accepts(plugin: PluginInfo): boolean;
    validate(): void;
    input(): Record<string, unknown>;
  },
): Promise<void> {
  try {
    const currentPlugin = () => {
      const plugin = usePlugins.getState().items.find((item) => item.id === action.pluginId);
      if (!plugin || plugin.fingerprint !== action.fingerprint || !context.accepts(plugin))
        throw new Error(i18n.t("pluginSecurity.changed"));
      return plugin;
    };
    const original = currentPlugin();
    context.validate();
    if (original.status !== "running") await usePlugins.getState().start(original.id);
    const current = currentPlugin();
    // start() reports launch failures. Declined consent leaves the plugin stopped.
    if (current.status !== "running") return;
    const result = await usePlugins.getState().execute(current.id, action.command, () => {
      currentPlugin();
      context.validate();
      return context.input();
    });
    const latest = usePlugins.getState().items.find((item) => item.id === action.pluginId);
    const security = usePluginSecurity.getState().state;
    if (
      !latest ||
      latest.status !== "running" ||
      latest.fingerprint !== action.fingerprint ||
      (isTauri() && (security.restricted || !hasPluginGrant(security, latest)))
    )
      return;
    if (
      result &&
      typeof result === "object" &&
      "text" in result &&
      typeof result.text === "string"
    ) {
      const output = normalizeResult(result);
      usePlugins.setState((state) => ({
        outputs: {
          ...state.outputs,
          [current.id]: { text: output.text, error: output.error },
        },
      }));
      useWorkspace.getState().openPluginView(current.id, "$command", current.name);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "plugin.permissionDenied") return;
    toast(
      error instanceof Error && error.message === "resultTooLarge"
        ? i18n.t("pluginView.resultTooLarge")
        : translateError(error),
      "error",
    );
  }
}
