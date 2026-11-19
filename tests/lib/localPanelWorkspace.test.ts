import { expect, it } from "vitest";
import { createLocalPanelWorkspace } from "@/lib/panels/localWorkspace";
import type { PanelLayoutNode } from "@/lib/layout/types";
const leaves = (node: PanelLayoutNode | null): string[] =>
  !node
    ? []
    : node.kind === "pane"
      ? [node.paneId]
      : [...leaves(node.first), ...leaves(node.second)];
it("reconciles native membership without touching unchanged groups, ratios or floating placements", () => {
  const w = createLocalPanelWorkspace();
  w.reconcile(["tasks", "connections", "tasks"]);
  expect(w.store.getState().groups[0]!.panels).toEqual(["tasks", "connections"]);
  w.split("connections", "row");
  const layout = w.store.getState().layout;
  if (layout?.kind !== "split") throw new Error("split required");
  w.resize({ [layout.id]: 0.3 });
  w.float("tasks");
  const state = w.store.getState();
  w.reconcile(["connections", "tasks"]);
  expect(w.store.getState()).toBe(state);
  w.reconcile(["tasks"]);
  expect(w.store.getState()).toMatchObject({ layout: null, groups: [], floating: ["tasks"] });
  w.reconcile(["tasks", "output"]);
  expect(w.store.getState().floating).toEqual(["tasks"]);
  expect(w.store.getState().groups[0]!.panels).toEqual(["output"]);
});
it("docks/reorders/merges and splits in both directions with finite atomic resize batches", () => {
  const w = createLocalPanelWorkspace();
  w.reconcile(["a", "b", "c", "d"]);
  w.split("b", "column", "before");
  const group = w.store.getState().groups.find((g) => g.panels.includes("b"))!;
  w.dock("c", group.id, "b");
  expect(w.store.getState().groups.find((g) => g.id === group.id)!.panels).toEqual(["c", "b"]);
  w.split("d", "row", "after", group.id);
  const state = w.store.getState();
  expect(leaves(state.layout)).toHaveLength(3);
  const ids: string[] = [];
  const collect = (n: PanelLayoutNode | null) => {
    if (n?.kind === "split") {
      ids.push(n.id);
      collect(n.first);
      collect(n.second);
    }
  };
  collect(state.layout);
  let changes = 0;
  w.store.subscribe(() => changes++);
  w.resize(Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0.4])));
  expect(changes).toBe(1);
  const updated = w.store.getState().layout;
  expect(updated).toMatchObject({ ratio: 0.85 });
  w.resize(Object.fromEntries(ids.map((id) => [id, NaN])));
  expect(w.store.getState().layout).toEqual(updated);
  w.dock("b", w.store.getState().groups.find((g) => g.panels.includes("a"))!.id);
  expect(w.store.getState().groups).toHaveLength(3); // c remains in its original group.
});
it("keeps every panel exactly once and prunes empty split branches under repeated presentation changes", () => {
  const w = createLocalPanelWorkspace();
  const expected = ["a", "b", "c", "d", "e"];
  w.reconcile(expected);
  for (let i = 0; i < 400; i++) {
    const panel = expected[(i * 17) % expected.length]!;
    switch (i % 5) {
      case 0:
        w.float(panel);
        break;
      case 1:
        w.dock(panel);
        break;
      case 2:
        w.split(panel, "row", "before");
        break;
      case 3:
        w.split(panel, "column", "after");
        break;
      case 4:
        w.activate(panel);
        break;
    }
    const state = w.store.getState();
    expect([...state.groups.flatMap((g) => g.panels), ...state.floating].sort()).toEqual(expected);
    expect(leaves(state.layout).sort()).toEqual(state.groups.map((g) => g.id).sort());
    expect(state.groups.every((g) => g.panels.includes(g.active))).toBe(true);
  }
  w.reconcile([]);
  expect(w.store.getState()).toEqual({ layout: null, groups: [], floating: [] });
});
