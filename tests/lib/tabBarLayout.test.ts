import { expect, it } from "vitest";
import { fitTabBarItems, groupTabBarItems, tabBarBudget } from "@/lib/plugins/tabBarLayout";

const items = [
  { id: "channel", width: 148, canOverflow: true },
  { id: "follow", width: 28, canOverflow: true },
  { id: "clear", width: 28, canOverflow: true },
];

it("reserves a closeable tab with both slots and native title-bar padding", () => {
  for (const width of [250, 300, 340, 800, 1400]) {
    const leading = tabBarBudget(width, 60, "leading", true);
    const trailing = tabBarBudget(width, 60, "trailing", true);
    expect(leading + trailing + 16 + 60 + 88).toBeLessThanOrEqual(width + 0.001);
    expect(tabBarBudget(width, 60, "trailing", false) + 8 + 60 + 88).toBeLessThanOrEqual(width);
  }
  expect(tabBarBudget(0, 60, "leading", true)).toBe(0);
});

it("fits all controls when possible, reserving a menu only when required", () => {
  expect([...fitTabBarItems(items, 204)]).toEqual(["channel", "follow", "clear"]);
  expect([...fitTabBarItems(items, 180)]).toEqual(["channel"]);
  expect([...fitTabBarItems(items, 40)]).toEqual([]);
  expect([...fitTabBarItems(items, 204)]).toHaveLength(3);
});
it("retains controls without a menu equivalent and drops lower priority controls first", () => {
  expect([
    ...fitTabBarItems([{ id: "custom", width: 35, canOverflow: false }, ...items], 65),
  ]).toEqual(["custom"]);
  expect([...fitTabBarItems(items, 206)]).toEqual(items.map((item) => item.id));
});
it("keeps each owner's groups together without merging groups across owners", () => {
  const grouped = groupTabBarItems([
    { id: "a", group: "plugin:one:tools" },
    { id: "b", group: "plugin:two:tools" },
    { id: "c", group: "plugin:one:tools" },
  ]);
  expect(grouped.map((item) => item.id)).toEqual(["a", "c", "b"]);
});
