import type { WorkspaceTab } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { parsePluginSidebar } from "./sidebars";

/** Only contributed views may opt out. Built-in pages never have an allowlist. */
export function canFloatTab(tab: Pick<WorkspaceTab, "id" | "kind">): boolean {
  if (tab.kind === "sidebar") return canFloatPluginView(tab.id.slice("sidebar:".length));
  if (tab.kind !== "pluginView") return true;
  return canFloatPluginView(tab.id);
}

export function canFloatPluginView(id: string): boolean {
  const parsed = parsePluginSidebar(id);
  if (!parsed) return true;
  const plugin = usePlugins.getState().items.find((item) => item.id === parsed.pluginId);
  return plugin?.views.find((view) => view.id === parsed.viewId)?.allowFloating !== false;
}
