import type { PluginInfo, Settings } from "@/lib/api/types";

/** Contributions are metadata; runtime status and grants are checked at mount. */
export function hostDetailsContributors(plugins: readonly PluginInfo[]) {
  return [...plugins]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((plugin) =>
      plugin.permissions.includes("hosts.read")
        ? (plugin.hostDetails ?? [])
            .filter(
              (item) =>
                (!item.kind ||
                  ["mounts.read", "mounts.hostDetails"].every((p) =>
                    plugin.permissions.includes(p),
                  )) &&
                plugin.views.some(
                  (view) =>
                    view.id === item.viewId &&
                    !view.provider &&
                    ((view.kind === "component" &&
                      plugin.frontend &&
                      plugin.permissions.includes("ui.trusted")) ||
                      (view.kind === "sharedMounts" &&
                        item.kind === "mounts" &&
                        [undefined, "node", "declarative"].includes(plugin.runtime))),
                ),
            )
            .map((contribution) => ({ plugin, contribution }))
        : [],
    );
}

export function selectedHostDetails(
  plugins: readonly PluginInfo[],
  selection: Settings["mountHostDetailsSelection"],
) {
  return hostDetailsContributors(plugins).filter(
    ({ plugin, contribution }) =>
      contribution.kind !== "mounts" ||
      (selection?.pluginId === plugin.id && selection.contributionId === contribution.id),
  );
}
