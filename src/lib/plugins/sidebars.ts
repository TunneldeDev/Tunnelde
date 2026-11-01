import type { PluginInfo } from "@/lib/api/types";

export type PluginSidebarView = `plugin:${string}:${string}`;
export const pluginSidebarId = (pluginId: string, viewId: string): PluginSidebarView =>
  `plugin:${pluginId}:${viewId}`;
export function parsePluginSidebar(value: string): { pluginId: string; viewId: string } | null {
  const match =
    /^plugin:([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}):([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})$/.exec(value);
  return match ? { pluginId: match[1]!, viewId: match[2]! } : null;
}
export function pluginSidebars(plugins: PluginInfo[]) {
  return plugins.flatMap((plugin) =>
    plugin.runtime === "theme"
      ? []
      : plugin.views
          .filter((view) => view.location === "sidebar")
          .map((view) => ({
            ...view,
            view: pluginSidebarId(plugin.id, view.id),
            pluginId: plugin.id,
          })),
  );
}
