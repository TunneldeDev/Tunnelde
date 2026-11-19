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
const stores = new Map<SidebarView, ReturnType<typeof createFloatingPanelStore>>();

function createFloatingPanelStore(view: SidebarView) {
  const key = `tunnelde.panels.${view}.bounds`;
  function readBounds(): FloatingRect | null {
    try {
      const raw =
        localStorage.getItem(key) ??
        (view === "tasks"
          ? (localStorage.getItem("tunnelde.backgroundTasks.bounds") ??
            localStorage.getItem("tunnelde.transferPanel.bounds"))
          : null);
      const value: unknown = JSON.parse(raw ?? "null");
      return isFloatingRect(value) ? value : null;
    } catch {
      return null;
    }
  }
  let preferred: PanelPresentation | null = null;
  try {
    const value = localStorage.getItem(`tunnelde.panels.${view}.presentation`);
    if (value === "sidebar" || value === "workspace" || value === "floating") preferred = value;
  } catch {
    /* Use the entry point default when storage is unavailable. */
  }
  const store = create<FloatingPanelState>((set) => ({
    preferred,
    setPreferred: (location) => {
      try {
        localStorage.setItem(`tunnelde.panels.${view}.presentation`, location);
      } catch {
        /* Session state still works. */
      }
      set({ preferred: location });
    },
    open: false,
    pinned: false,
    bounds: readBounds(),
    order: 0,
    setBounds: (bounds) => {
      if (bounds && !isFloatingRect(bounds)) return;
      try {
        if (bounds) localStorage.setItem(key, JSON.stringify(bounds));
        else localStorage.removeItem(key);
        if (view === "tasks") {
          localStorage.removeItem("tunnelde.backgroundTasks.bounds");
          localStorage.removeItem("tunnelde.transferPanel.bounds");
        }
      } catch {
        /* In-memory geometry still works without browser storage. */
      }
      set({ bounds });
    },
    show: () => set({ open: true, order: ++order }),
    close: () => set({ open: false }),
    toggle: () => set((state) => ({ open: !state.open, order: ++order })),
    togglePinned: () => set((state) => ({ pinned: !state.pinned })),
    raise: () => set({ order: ++order }),
  }));
  store.subscribe((state) =>
    usePanelPresentations.setState((all) => ({
      panels: { ...all.panels, [view]: state },
    })),
  );
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
