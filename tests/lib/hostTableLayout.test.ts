import { expect, it } from "vitest";
import { hostTableLayout, type DisplayHostColumn } from "@/lib/hosts/columns";
const columns = ["name", "address", "user"].map(
  (key, i) =>
    ({
      key,
      label: key,
      width: [200, 180, 100][i]!,
      type: "text" as const,
      values: new Map(),
    }) satisfies DisplayHostColumn,
);
it("fits default columns in a narrow pane until their readable minima require scrolling", () => {
  expect(hostTableLayout(columns, {})).toEqual({
    columns: "minmax(120px, 200fr) minmax(140px, 180fr) minmax(96px, 100fr)",
    minimum: 356,
  });
});
it("respects explicit widths while leaving other columns flexible", () => {
  expect(hostTableLayout(columns, { name: 200 })).toEqual({
    columns: "200px minmax(140px, 180fr) minmax(96px, 100fr)",
    minimum: 436,
  });
  expect(hostTableLayout(columns, { name: 200, address: 180, user: 100 }).minimum).toBe(480);
});
