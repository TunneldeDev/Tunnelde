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
  return withPluginInvocation(
    original,
    async (plugin, signal, check) => {
      if (options.interactive && isTauri() && !(await authorizePluginAction(id, signal)))
        return null;
      check();
      return api.pluginRenderView(id, view, locale, plugin.runtimeId ?? "");
    },
    options.signal,
  );
}
