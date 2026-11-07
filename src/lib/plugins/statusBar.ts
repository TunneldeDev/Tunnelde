/** Plugin status bar v1 DTOs. Keep these independent of workspace/store state. */
export interface PluginStatusBarItem {
  id: string;
  text: string;
  alignment: "left" | "right";
  priority: number;
  tooltip: string | null;
  icon:
    | "activity"
    | "check"
    | "alert"
    | "info"
    | "sync"
    | "terminal"
    | "cloud"
    | "code"
    | "plug"
    | null;
  command: string | null;
  pluginId: string;
  pluginName: string;
  /** Opaque host-issued click identity, replaced on every update. */
  token: string;
}

export interface StatusBarSnapshot {
  revision: number;
  items: PluginStatusBarItem[];
}

export function orderStatusItems<T extends { id: string; priority: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
