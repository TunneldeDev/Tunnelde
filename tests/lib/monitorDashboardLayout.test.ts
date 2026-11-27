import { expect, it } from "vitest";
import {
  defaultDashboardLayout,
  moveWidget,
  readDashboardLayout,
  resizeWidget,
} from "@/features/monitor/dashboardLayout";
it("normalizes persisted dimensions, discards unknown/duplicate widgets and adds newly available cards", () => {
  const layout = readDashboardLayout(
    JSON.stringify({
      version: 1,
      widgets: [
        { id: "disk", columns: 99, height: 9000 },
        { id: "disk", columns: 4 },
        { id: "foreign" },
        { id: "cpu", columns: -10, height: -12 },
        { id: "gpu", height: "secret" },
      ],
    }),
  );
  expect(layout.map((w) => w.id)).toEqual(["disk", "cpu", "gpu", "memory", "network"]);
  expect(layout[0]).toEqual({ id: "disk", columns: 12, height: 1200 });
  expect(layout[1]).toEqual({ id: "cpu", columns: 4, height: 280 });
  expect(layout[2]?.height).toBeNull();
  for (const raw of [null, "{", "[]", '{"version":2,"widgets":[]}', '{"version":1,"widgets":null}'])
    expect(readDashboardLayout(raw)).toEqual(defaultDashboardLayout());
});
it("moves without losing any identities and preserves desktop widths during narrow-panel resizing", () => {
  const layout = defaultDashboardLayout();
  expect(moveWidget(layout, "cpu", "gpu").map((w) => w.id)).toEqual([
    "memory",
    "network",
    "disk",
    "gpu",
    "cpu",
  ]);
  expect(layout[0]?.id).toBe("cpu");
  expect(resizeWidget(layout[0]!, 600, 460, 600, 100, 1200, 12)).toMatchObject({
    columns: 12,
    height: 560,
  });
  expect(resizeWidget(layout[0]!, 300, 460, -9999, -9999, 300, 1)).toMatchObject({
    columns: 6,
    height: 280,
  });
});
