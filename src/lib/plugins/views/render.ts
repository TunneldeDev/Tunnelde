import type { PluginInfo } from "@/lib/api/types";
import { api, isTauri } from "@/lib/api/ipc";
import { withPluginInvocation } from "@/lib/plugins/commands/runtime";
import { usePlugins } from "@/store/plugins";
import { authorizePluginAction } from "@/store/pluginSecurity";

/** Rendering never starts an engine. Capture its owner before consent or IPC,
 * including refreshes of legacy JSON views and agent readiness snapshots. */
export function renderPluginView(
  id: string,
  view: string,
  locale: string | undefined,
  options: { interactive?: boolean; signal?: AbortSignal } = {},
) {
  const original = usePlugins.getState().items.find((plugin) => plugin.id === id);
  return renderOwnedPluginView(original, view, locale, options);
}

/** Render against the already captured owner; never retarget a stale renderer
 * to the current plugin instance after a consent or transport wait. */
export function renderOwnedPluginView(
  original: PluginInfo | undefined,
  view: string,
  locale: string | undefined,
  options: { interactive?: boolean; signal?: AbortSignal } = {},
) {
  return withPluginInvocation(
    original,
    async (plugin, signal, check) => {
      if (options.interactive && isTauri() && !(await authorizePluginAction(plugin.id, signal)))
        return null;
      check();
      return api.pluginRenderView(plugin.id, view, locale, plugin.runtimeId ?? "");
    },
    options.signal,
  );
}
