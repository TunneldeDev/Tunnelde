import type { StoreApi } from "zustand";
import type { FloatingPanelState } from "@/store/panelPresentation";
import { visibleLocalPanelLayout, type LocalPanelWorkspace } from "./localWorkspace";
import type { SourcePanelMetadata, SourcePanelPresentation } from "./sourcePresentation";

/** Satellite-only layout adapter. It has no imports from feature stores, main
 * workspace persistence, plugin activation or SSH/resource ownership. */
export function createLocalPanelPresentation(
  windowId: string,
  workspace: LocalPanelWorkspace,
  floating: () => ReadonlyMap<string, StoreApi<FloatingPanelState>>,
): SourcePanelPresentation {
  const read = (): SourcePanelMetadata[] => {
    const state = workspace.store.getState();
    const shown = visibleLocalPanelLayout(state);
    const ids = [...state.groups.flatMap((group) => group.panels), ...state.floating];
    return ids.map((id) => {
      const slot = floating().get(id)?.getState();
      const isFloating = state.floating.includes(id);
      const visible = isFloating
        ? shown.floating.includes(id)
        : shown.groups.some((group) => group.active === id);
      return {
        id,
        windowId,
        presentation: isFloating ? "floating" : "workspace",
        visible,
        pinned: slot?.pinned ?? true,
        bounds: slot?.bounds ? { ...slot.bounds } : null,
        available: !!slot,
        presentations: ["workspace", "floating"],
      };
    });
  };
  const requirePanel = (id: string) => {
    if (!read().some((panel) => panel.id === id && panel.available))
      throw new Error("panel.window.viewNotReady");
  };
  return {
    read,
    set(id, presentation) {
      requirePanel(id);
      if (presentation !== "workspace" && presentation !== "floating")
        throw new Error("panel.window.unsupportedPresentation");
      const isFloating = workspace.store.getState().floating.includes(id);
      if (presentation === "floating" && !isFloating) workspace.float(id);
      else if (presentation === "workspace" && isFloating) workspace.dock(id);
      workspace.activate(id);
      return read().find((panel) => panel.id === id)!;
    },
    close(id) {
      requirePanel(id);
      workspace.hide(id);
    },
    reveal(id) {
      requirePanel(id);
      workspace.activate(id);
    },
    subscribe(changed) {
      const subscriptions = new Map<StoreApi<FloatingPanelState>, () => void>();
      const rewire = () => {
        const active = new Set(floating().values());
        for (const [store, stop] of subscriptions)
          if (!active.has(store)) {
            stop();
            subscriptions.delete(store);
          }
        for (const store of active)
          if (!subscriptions.has(store)) subscriptions.set(store, store.subscribe(changed));
      };
      rewire();
      const stop = workspace.store.subscribe(() => {
        rewire();
        changed();
      });
      return () => {
        stop();
        for (const stop of subscriptions.values()) stop();
        subscriptions.clear();
      };
    },
  };
}
