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
it("keeps every panel exactly once and prunes empty split branches under repeated presentation changes", async () => {
  const w = createLocalPanelWorkspace();
  const expected = ["a", "b", "c", "d", "e"];
  const { visibleLocalPanelLayout } = await import("@/lib/panels/localWorkspace");
  w.reconcile(expected);
  for (let i = 0; i < 400; i++) {
    const panel = expected[(i * 17) % expected.length]!;
    switch (i % 7) {
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
      case 5:
        w.hide(panel);
        break;
      case 6:
        w.reconcile([...expected].reverse());
        break;
    }
    const state = w.store.getState();
    expect([...state.groups.flatMap((g) => g.panels), ...state.floating].sort()).toEqual(expected);
    expect(leaves(state.layout).sort()).toEqual(state.groups.map((g) => g.id).sort());
    expect(state.groups.every((g) => g.panels.includes(g.active))).toBe(true);
    expect(new Set(state.hidden).size).toBe(state.hidden.length);
    expect(state.hidden.every((id) => expected.includes(id))).toBe(true);
    const shown = visibleLocalPanelLayout(state);
    expect(leaves(shown.layout).sort()).toEqual(shown.groups.map((group) => group.id).sort());
    expect(
      [...shown.groups.flatMap((group) => group.panels), ...shown.floating].every(
        (id) => !state.hidden.includes(id),
      ),
    ).toBe(true);
  }
  w.reconcile([]);
  expect(w.store.getState()).toEqual({ layout: null, groups: [], floating: [], hidden: [] });
});
it("does not move an entire existing split group when its only tab is dropped back onto itself", () => {
  const w = createLocalPanelWorkspace();
  w.reconcile(["a", "b"]);
  w.split("b", "row");
  const own = w.store.getState().groups.find((g) => g.panels.includes("b"))!;
  const state = w.store.getState();
  w.split("b", "column", "before", own.id);
  expect(w.store.getState()).toBe(state);
  w.dock("b", own.id);
  expect(w.store.getState()).toBe(state);
});

it("hides without deleting slots or split geometry and reveal restores the exact group", async () => {
  const { visibleLocalPanelLayout } = await import("@/lib/panels/localWorkspace");
  const w = createLocalPanelWorkspace();
  w.reconcile(["a", "b", "c"]);
  w.split("b", "row");
  const original = w.store.getState();
  w.hide("b");
  expect(w.store.getState().groups).toBe(original.groups);
  expect(w.store.getState().layout).toBe(original.layout);
  expect(visibleLocalPanelLayout(w.store.getState()).groups).toHaveLength(1);
  expect(visibleLocalPanelLayout(w.store.getState()).layout?.kind).toBe("pane");
  const hidden = w.store.getState();
  w.reconcile(["a", "b", "c"]);
  w.hide("b");
  expect(w.store.getState()).toBe(hidden);
  w.activate("b");
  expect(w.store.getState().hidden).toEqual([]);
  expect(w.store.getState().layout).toBe(original.layout);
  expect(w.store.getState().groups.find((g) => g.panels.includes("b"))?.id).toBe(
    original.groups.find((g) => g.panels.includes("b"))?.id,
  );
  w.float("c");
  w.hide("c");
  expect(w.store.getState().floating).toEqual(["c"]);
  expect(visibleLocalPanelLayout(w.store.getState()).floating).toEqual([]);
  w.activate("c");
  expect(visibleLocalPanelLayout(w.store.getState()).floating).toEqual(["c"]);
  w.hide("a");
  w.reconcile(["b", "c"]);
  expect(w.store.getState().hidden).toEqual([]);
  const current = w.store.getState();
  w.hide("absent");
  w.activate("absent");
  expect(w.store.getState()).toBe(current);
});

it("does not offer hidden tabs or groups as visible move destinations", async () => {
  const { localPanelMoveActions } = await import("@/lib/panels/localWorkspaceActions");
  const w = createLocalPanelWorkspace();
  w.reconcile(["a", "b"]);
  w.split("b", "row");
  w.hide("b");
  const actions = localPanelMoveActions(w, "a", ((key: string) => key) as never);
  expect(actions.filter((action) => action.label === "panels.moveToGroup")).toEqual([]);
  expect(actions.filter((action) => action.label.startsWith("docking.move"))).toEqual(
    expect.arrayContaining([expect.objectContaining({ disabled: true })]),
  );
});
