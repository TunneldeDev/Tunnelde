/** Additive presentation DTOs; saved host identity and connection state stay independent. */
export interface HostDecoration {
  hostId: string;
  badge: string | null;
  description: string | null;
  tooltip: string | null;
  icon:
    | "server"
    | "cloud"
    | "container"
    | "database"
    | "globe"
    | "code"
    | "terminal"
    | "shield"
    | "key"
    | "activity"
    | null;
  tone: "neutral" | "info" | "success" | "warning" | "error";
}
export interface HostDecorationSet {
  id: string;
  priority: number;
  decorations: HostDecoration[];
  pluginId: string;
  pluginName: string;
}
export interface HostDecorationSnapshot {
  revision: number;
  items: HostDecorationSet[];
}
export interface OwnedHostDecoration extends HostDecoration {
  key: string;
  pluginName: string;
}

/** Index once per native snapshot, not once per rendered host or resize. */
export function indexHostDecorations(
  items: HostDecorationSet[],
): ReadonlyMap<string, OwnedHostDecoration[]> {
  const index = new Map<string, OwnedHostDecoration[]>();
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...items].sort(
    (a, b) => b.priority - a.priority || compare(a.pluginId, b.pluginId) || compare(a.id, b.id),
  );
  for (const set of sorted)
    for (const item of set.decorations) {
      const values = index.get(item.hostId) ?? [];
      values.push({
        ...item,
        key: JSON.stringify([set.pluginId, set.id]),
        pluginName: set.pluginName,
      });
      index.set(item.hostId, values);
    }
  return index;
}
