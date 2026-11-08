/** Declarative controls only. Context IDs are opaque and confer no authority. */
export interface PluginTabBarItem {
  id: string;
  title: string;
  kind: "button" | "select" | "text";
  priority: number;
  icon: string | null;
  command: string | null;
  disabled: boolean;
  when: { tabKind?: string | null; tabId?: string | null } | null;
  options: { value: string; label: string }[];
  value: string | null;
  pluginId: string;
  pluginName: string;
  token: string;
}
export interface TabBarSnapshot {
  revision: number;
  items: PluginTabBarItem[];
}
export interface TabBarContext {
  tabId: string;
  tabKind: string;
  paneId: string;
}

export function tabBarMatches(item: PluginTabBarItem, context: TabBarContext): boolean {
  if (!item.when)
    return (
      (context.tabKind === "plugin" && context.tabId.startsWith(`plugin:${item.pluginId}:`)) ||
      (context.tabKind === "sidebar" &&
        context.tabId.startsWith(`sidebar:plugin:${item.pluginId}:`))
    );
  return (
    (!item.when.tabId || item.when.tabId === context.tabId) &&
    (!item.when.tabKind || item.when.tabKind === context.tabKind)
  );
}
