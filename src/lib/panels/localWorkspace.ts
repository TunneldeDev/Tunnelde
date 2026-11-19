import { createStore } from "zustand/vanilla";
import type { PanelLayoutNode, SplitDirection } from "@/lib/layout/types";

export interface LocalPanelGroup {
  id: string;
  panels: string[];
  active: string;
}
export interface LocalPanelLayout {
  groups: LocalPanelGroup[];
  floating: string[];
  layout: PanelLayoutNode | null;
}
function prune(node: PanelLayoutNode | null, groups: Set<string>): PanelLayoutNode | null {
  if (!node) return null;
  if (node.kind === "pane") return groups.has(node.paneId) ? node : null;
  const first = prune(node.first, groups),
    second = prune(node.second, groups);
  return first && second ? { ...node, first, second } : (first ?? second);
}
function replace(node: PanelLayoutNode, target: string, next: PanelLayoutNode): PanelLayoutNode {
  if (node.kind === "pane") return node.paneId === target ? next : node;
  return {
    ...node,
    first: replace(node.first, target, next),
    second: replace(node.second, target, next),
  };
}
function clean(state: LocalPanelLayout, valid: Set<string>): LocalPanelLayout {
  const groups = state.groups.flatMap((group) => {
    const panels = group.panels.filter((id) => valid.has(id));
    return panels.length
      ? [{ ...group, panels, active: panels.includes(group.active) ? group.active : panels[0]! }]
      : [];
  });
  return {
    groups,
    layout: prune(state.layout, new Set(groups.map((g) => g.id))),
    floating: state.floating.filter((id) => valid.has(id)),
  };
}

/** Document-local presentation only. No persistence, resource owners or native
 * identities: native leases remain the sole authority for cross-window moves. */
export function createLocalPanelWorkspace() {
  let serial = 0;
  const id = () => `panel-group-${++serial}`;
  const store = createStore<LocalPanelLayout>(() => ({ groups: [], floating: [], layout: null }));
  const known = () =>
    new Set([...store.getState().groups.flatMap((g) => g.panels), ...store.getState().floating]);
  const without = (panel: string) => {
    const valid = known();
    valid.delete(panel);
    return clean(store.getState(), valid);
  };
  const group = (panel: string): LocalPanelGroup => ({ id: id(), panels: [panel], active: panel });
  const dock = (panel: string, target?: string, before?: string) => {
    if (!known().has(panel)) return;
    if (
      target &&
      store
        .getState()
        .groups.some(
          (group) => group.id === target && group.panels.length === 1 && group.panels[0] === panel,
        )
    )
      return;
    const state = without(panel);
    const destination = state.groups.find((g) => g.id === target) ?? state.groups[0];
    if (!destination) {
      const next = group(panel);
      store.setState({ ...state, groups: [next], layout: { kind: "pane", paneId: next.id } });
      return;
    }
    const panels = [...destination.panels];
    const index = before ? panels.indexOf(before) : -1;
    panels.splice(index < 0 ? panels.length : index, 0, panel);
    store.setState({
      ...state,
      groups: state.groups.map((g) =>
        g.id === destination.id ? { ...g, panels, active: panel } : g,
      ),
    });
  };
  return {
    store,
    reconcile(incoming: readonly string[]) {
      const panels = [...new Set(incoming)];
      const valid = new Set(panels),
        state = clean(store.getState(), valid);
      const present = new Set([...state.groups.flatMap((g) => g.panels), ...state.floating]);
      const added = panels.filter((panel) => !present.has(panel));
      if (added.length) {
        if (state.groups.length) {
          const first = state.groups[0]!;
          state.groups = [
            { ...first, panels: [...first.panels, ...added], active: added.at(-1)! },
            ...state.groups.slice(1),
          ];
        } else {
          const next = group(added[0]!);
          next.panels = added;
          next.active = added.at(-1)!;
          state.groups = [next];
          state.layout = { kind: "pane", paneId: next.id };
        }
      }
      // Avoid rerendering read-model progress frames when membership is unchanged.
      const previous = store.getState();
      if (
        JSON.stringify([state.groups, state.floating, state.layout]) !==
        JSON.stringify([previous.groups, previous.floating, previous.layout])
      )
        store.setState(state);
    },
    dock,
    split(
      panel: string,
      direction: SplitDirection,
      position: "before" | "after" = "after",
      target?: string,
    ) {
      if (!known().has(panel)) return;
      if (
        target &&
        store
          .getState()
          .groups.some(
            (group) =>
              group.id === target && group.panels.length === 1 && group.panels[0] === panel,
          )
      )
        return;
      const state = without(panel);
      const destination = state.groups.find((g) => g.id === target) ?? state.groups[0];
      if (!destination || !state.layout) {
        dock(panel);
        return;
      }
      const next = group(panel),
        leaf = { kind: "pane" as const, paneId: next.id };
      const previous = { kind: "pane" as const, paneId: destination.id };
      state.layout = replace(state.layout, destination.id, {
        kind: "split",
        id: `panel-split-${++serial}`,
        direction,
        ratio: 0.5,
        first: position === "before" ? leaf : previous,
        second: position === "before" ? previous : leaf,
      });
      store.setState({ ...state, groups: [...state.groups, next] });
    },
    float(panel: string) {
      if (!known().has(panel)) return;
      const state = without(panel);
      store.setState({ ...state, floating: [...state.floating, panel] });
    },
    activate(panel: string) {
      const state = store.getState();
      if (state.floating.includes(panel))
        store.setState({ floating: [...state.floating.filter((id) => id !== panel), panel] });
      else
        store.setState({
          groups: state.groups.map((g) => (g.panels.includes(panel) ? { ...g, active: panel } : g)),
        });
    },
    resize(ratios: Record<string, number>) {
      const visit = (node: PanelLayoutNode): PanelLayoutNode =>
        node.kind === "pane"
          ? node
          : {
              ...node,
              ratio: Number.isFinite(ratios[node.id])
                ? Math.max(0.15, Math.min(0.85, ratios[node.id]!))
                : node.ratio,
              first: visit(node.first),
              second: visit(node.second),
            };
      const { layout } = store.getState();
      if (layout) store.setState({ layout: visit(layout) });
    },
  };
}
export type LocalPanelWorkspace = ReturnType<typeof createLocalPanelWorkspace>;
