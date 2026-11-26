import { habitStorage } from "@/lib/habits/storage";
import { create } from "zustand";
import type { SidebarView } from "./navigation";
import { isFloatingRect, type FloatingRect } from "@/lib/layout/floatingPanel";

export type PanelPresentation = "sidebar" | "workspace" | "floating";

export interface FloatingPanelState {
  preferred: PanelPresentation | null;
  setPreferred: (location: PanelPresentation) => void;
  open: boolean;
  pinned: boolean;
  bounds: FloatingRect | null;
  order: number;
  setBounds: (bounds: FloatingRect | null) => void;
  show: () => void;
  close: () => void;
  toggle: () => void;
  togglePinned: () => void;
  raise: () => void;
}

/** Shared presentation state only; no business work or workspace mutations live here. */
export const usePanelPresentations = create<{
  panels: Partial<Record<SidebarView, FloatingPanelState>>;
}>(() => ({ panels: {} }));
let order = 0;
/** One stacking clock for all same-document floating adapters. */
export const nextPanelOrder = () => ++order;
const stores = new Map<SidebarView, ReturnType<typeof createFloatingPanelStore>>();

function createFloatingPanelStore(view: SidebarView) {
  const key = `tunnelde.panels.${view}.bounds`;
  function readBounds(): FloatingRect | null {
    try {
      const raw =
        habitStorage.getItem(key) ??
        (view === "tasks"
          ? (habitStorage.getItem("tunnelde.backgroundTasks.bounds") ??
            habitStorage.getItem("tunnelde.transferPanel.bounds"))
          : null);
      const value: unknown = JSON.parse(raw ?? "null");
      return isFloatingRect(value) ? value : null;
    } catch {
      return null;
    }
  }
  let preferred: PanelPresentation | null = null;
  try {
    const value = habitStorage.getItem(`tunnelde.panels.${view}.presentation`);
    if (value === "sidebar" || value === "workspace" || value === "floating") preferred = value;
  } catch {
    /* Use the entry point default when storage is unavailable. */
  }
  const store = create<FloatingPanelState>((set) => ({
    preferred,
    setPreferred: (location) => {
      try {
        habitStorage.setItem(`tunnelde.panels.${view}.presentation`, location);
      } catch {
        /* Session state still works. */
      }
      set({ preferred: location });
    },
    open: habitStorage.getItem(`tunnelde.panels.${view}.open`) === "true",
    pinned: habitStorage.getItem(`tunnelde.panels.${view}.pinned`) === "true",
    bounds: readBounds(),
    order: 0,
    setBounds: (bounds) => {
      if (bounds && !isFloatingRect(bounds)) return;
      try {
        if (bounds) habitStorage.setItem(key, JSON.stringify(bounds));
        else habitStorage.removeItem(key);
        if (view === "tasks") {
          habitStorage.removeItem("tunnelde.backgroundTasks.bounds");
          habitStorage.removeItem("tunnelde.transferPanel.bounds");
        }
      } catch {
        /* In-memory geometry still works without browser storage. */
      }
      set({ bounds });
    },
    show: () => set({ open: true, order: nextPanelOrder() }),
    close: () => set({ open: false }),
    toggle: () => set((state) => ({ open: !state.open, order: nextPanelOrder() })),
    togglePinned: () => set((state) => ({ pinned: !state.pinned })),
    raise: () => set({ order: nextPanelOrder() }),
  }));
  store.subscribe((state, previous) => {
    if (state.open !== previous.open)
      habitStorage.setItem(`tunnelde.panels.${view}.open`, String(state.open));
    if (state.pinned !== previous.pinned)
      habitStorage.setItem(`tunnelde.panels.${view}.pinned`, String(state.pinned));
    usePanelPresentations.setState((all) => ({ panels: { ...all.panels, [view]: state } }));
  });
  return store;
}

export function panelPresentation(view: SidebarView) {
  let store = stores.get(view);
  if (!store) {
    store = createFloatingPanelStore(view);
    stores.set(view, store);
  }
  return store;
}

/** Rehydrate already-created stores after the durable cache has been read. */
export function restorePanelHabits() {
  for (const [view, store] of stores) {
    const read = createFloatingPanelStore(view).getState();
    store.setState({
      preferred: read.preferred,
      bounds: read.bounds,
      open: read.open,
      pinned: read.pinned,
    });
  }
}
