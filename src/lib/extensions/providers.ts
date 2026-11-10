import type { PluginInfo, Settings } from "@/lib/api/types";
import type { FrontendProviderTarget } from "./contracts/frontend/providers";

export function uiProviders(plugins: readonly PluginInfo[], target: FrontendProviderTarget) {
  return [...plugins]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((plugin) =>
      plugin.frontend &&
      plugin.permissions.includes("ui.trusted") &&
      (target !== "hostList" || plugin.permissions.includes("hosts.read")) &&
      (target !== "fileBrowser" ||
        ["fs.read", "sftp.read", "workspace.write"].every((p) => plugin.permissions.includes(p))) &&
      (target !== "terminal" ||
        ["sessions.read", "ssh.exec"].every((p) => plugin.permissions.includes(p))) &&
      (target !== "history" ||
        ["sessions.read", "history.read"].every((p) => plugin.permissions.includes(p))) &&
      (target !== "forwarding" ||
        ["hosts.read", "forwards.read"].every((p) => plugin.permissions.includes(p))) &&
      (!["monitor", "processes"].includes(target) ||
        ["sessions.read", "monitor.read"].every((p) => plugin.permissions.includes(p))) &&
      (target !== "backgroundTasks" || plugin.permissions.includes("backgroundTasks.read"))
        ? plugin.views
            .filter((view) => view.kind === "component" && view.provider === target)
            .map((view) => ({ plugin, view }))
        : [],
    );
}

export function selectedUiProvider(
  plugins: readonly PluginInfo[],
  selections: Settings["uiProviders"],
  target: FrontendProviderTarget,
) {
  const selected = selections?.[target];
  return (
    selected &&
    uiProviders(plugins, target).find(
      ({ plugin, view }) => plugin.id === selected.pluginId && view.id === selected.viewId,
    )
  );
}
