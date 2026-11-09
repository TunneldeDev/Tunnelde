import type { Group, Host } from "@/lib/api/types";

// BEGIN GENERATED HOST COLUMNS V1 TYPES
/** Experimental runtime-owned host table presentation. No executable cell content. */
export interface HostColumn {
  id: string;
  label: string;
  type: "text" | "number" | "boolean";
  width?: number;
  cells: { hostId: string; value: string | number | boolean; tooltip?: string }[];
}
export interface HostColumnContribution extends HostColumn {
  pluginId: string;
  pluginName: string;
}
export interface HostColumnsSnapshot {
  revision: number;
  items: HostColumnContribution[];
}
// END GENERATED HOST COLUMNS V1 TYPES

export interface HostListPreferences {
  view: "tree" | "table";
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  sort: { key: string; direction: "asc" | "desc" } | null;
}
export const defaultHostListPreferences = (): HostListPreferences => ({
  view: "tree",
  order: ["name", "address", "user", "port", "group"],
  hidden: ["port", "group"],
  widths: {},
  sort: null,
});
export interface DisplayHostColumn {
  key: string;
  label: string;
  source?: string;
  width: number;
  type: HostColumn["type"];
  values: ReadonlyMap<string, { value: string | number | boolean; tooltip?: string }>;
}
export const hostColumnKey = (pluginId: string, id: string) => `plugin/${pluginId}/${id}`;
export function indexHostColumns(items: HostColumnContribution[]): DisplayHostColumn[] {
  return [...items]
    .sort((a, b) =>
      a.pluginId < b.pluginId
        ? -1
        : a.pluginId > b.pluginId
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    )
    .map((item) => ({
      key: hostColumnKey(item.pluginId, item.id),
      label: item.label,
      source: item.pluginName,
      width: item.width ?? 140,
      type: item.type,
      values: new Map(
        item.cells.map((cell) => [
          cell.hostId,
          { value: cell.value, ...(cell.tooltip ? { tooltip: cell.tooltip } : {}) },
        ]),
      ),
    }));
}
export function builtinHostColumns(
  hosts: Host[],
  groups: Group[],
  labels: Record<string, string>,
): DisplayHostColumn[] {
  const names = new Map(groups.map((group) => [group.id, group.name]));
  return ["name", "address", "user", "port", "group"].map((key) => ({
    key,
    label: labels[key] ?? key,
    width: key === "name" ? 200 : key === "address" ? 180 : 100,
    type: key === "port" ? "number" : "text",
    values: new Map(
      hosts.map((host) => [
        host.id,
        {
          value:
            key === "address"
              ? host.host
              : key === "user"
                ? host.username
                : key === "group"
                  ? (names.get(host.groupId ?? "") ?? "")
                  : key === "port"
                    ? host.port
                    : host.name,
        },
      ]),
    ),
  }));
}
export function visibleHostColumns(
  columns: DisplayHostColumn[],
  preferences: HostListPreferences,
): DisplayHostColumn[] {
  const order = [
    ...new Set(["name", ...preferences.order, ...columns.map((column) => column.key)]),
  ];
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return order.flatMap((key) => {
    const column = byKey.get(key);
    return !column || (key !== "name" && preferences.hidden.includes(key))
      ? []
      : [
          {
            ...column,
            width: Math.max(64, Math.min(480, preferences.widths[key] ?? column.width)),
          },
        ];
  });
}
export function sortHostRows(
  hosts: Host[],
  columns: DisplayHostColumn[],
  sort: HostListPreferences["sort"],
): Host[] {
  const column = sort && columns.find((column) => column.key === sort.key);
  if (!column || !sort) return hosts;
  return [...hosts].sort((a, b) => {
    const x = column.values.get(a.id)?.value,
      y = column.values.get(b.id)?.value;
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    const compared =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : typeof x === "boolean" && typeof y === "boolean"
          ? Number(x) - Number(y)
          : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return (sort.direction === "asc" ? 1 : -1) * compared;
  });
}
export function moveHostColumn(order: readonly string[], from: string, to: string): string[] {
  if (
    from === "name" ||
    to === "name" ||
    from === to ||
    !order.includes(from) ||
    !order.includes(to)
  )
    return [...order];
  const result = order.filter((key) => key !== from);
  result.splice(order.indexOf(to), 0, from);
  return result;
}
