import { describe, expect, it } from "vitest";
import {
  defaultHostListPreferences,
  indexHostColumns,
  visibleHostColumns,
  sortHostRows,
  moveHostColumn,
  type HostColumnContribution,
} from "@/lib/hosts/columns";
import type { Host } from "@/lib/api/types";
const contribution = (
  pluginId: string,
  type: HostColumnContribution["type"],
  values: (string | number | boolean)[],
): HostColumnContribution => ({
  pluginId,
  pluginName: pluginId,
  id: "data",
  label: "Data",
  type,
  cells: values.map((value, i) => ({ hostId: String(i), value })),
});
const hosts = ["0", "1", "2", "3"].map((id) => ({ id }) as Host);
describe("host column projection and preference reconciliation", () => {
  it("keeps plugin IDs isolated, indexes once and preserves zero, false and empty text", () => {
    const columns = indexHostColumns([
      contribution("b", "boolean", [false, true]),
      contribution("a", "number", [0, 10]),
    ]);
    expect(columns.map((column) => column.key)).toEqual(["plugin/a/data", "plugin/b/data"]);
    expect(columns[0]!.values.get("0")?.value).toBe(0);
    expect(columns[1]!.values.get("0")?.value).toBe(false);
  });
  it("sorts typed values naturally with absent values last in both directions", () => {
    for (const [type, values] of [
      ["text", ["host10", "host2", ""]],
      ["number", [10, 2, 0]],
      ["boolean", [true, false, false]],
    ] as const) {
      const columns = indexHostColumns([contribution("a", type, [...values])]);
      expect(
        sortHostRows(hosts, columns, { key: "plugin/a/data", direction: "asc" }).map(
          (host) => host.id,
        ),
      ).toEqual(type === "boolean" ? ["1", "2", "0", "3"] : ["2", "1", "0", "3"]);
      expect(
        sortHostRows(hosts, columns, { key: "plugin/a/data", direction: "desc" }).at(-1)?.id,
      ).toBe("3");
    }
    expect(sortHostRows(hosts, [], { key: "gone", direction: "asc" })).toBe(hosts);
  });
  it("reconciles absent providers without erasing preferences and pins host identity", () => {
    const preferences = defaultHostListPreferences();
    preferences.order = ["plugin/a/data", "name"];
    preferences.hidden = ["name"];
    preferences.widths = { "plugin/a/data": 900 };
    const columns = [
      { key: "name", label: "Name", type: "text" as const, width: 200, values: new Map() },
      ...indexHostColumns([contribution("a", "number", [1])]),
    ];
    expect(
      visibleHostColumns(columns, preferences).map((column) => [column.key, column.width]),
    ).toEqual([
      ["name", 200],
      ["plugin/a/data", 480],
    ]);
    expect(visibleHostColumns(columns.slice(0, 1), preferences)).toHaveLength(1);
    expect(preferences.order).toContain("plugin/a/data");
    const order = ["name", "address", "user", "plugin/a/data"];
    expect(moveHostColumn(order, "name", "user")).toEqual(order);
    expect(moveHostColumn(order, "user", "address")).toEqual([
      "name",
      "user",
      "address",
      "plugin/a/data",
    ]);
  });
});
