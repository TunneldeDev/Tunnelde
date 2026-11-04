import { create } from "zustand";
import { isFloatingRect, type FloatingRect } from "@/lib/layout/floatingPanel";

const layoutKey = "tunnelde.backgroundTasks.bounds";
const legacyLayoutKey = "tunnelde.transferPanel.bounds";
function readBounds(): FloatingRect | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(layoutKey) ?? localStorage.getItem(legacyLayoutKey) ?? "null",
    );
    return isFloatingRect(value) ? value : null;
  } catch {
    return null;
  }
}

export const useBackgroundTaskPanel = create<{
  open: boolean;
  pinned: boolean;
  bounds: FloatingRect | null;
  setBounds: (bounds: FloatingRect | null) => void;
  show: () => void;
  close: () => void;
  toggle: () => void;
  togglePinned: () => void;
}>((set) => ({
  open: false,
  pinned: false,
  bounds: readBounds(),
  setBounds: (bounds) => {
    try {
      if (bounds) localStorage.setItem(layoutKey, JSON.stringify(bounds));
      else localStorage.removeItem(layoutKey);
      localStorage.removeItem(legacyLayoutKey);
    } catch {
      /* Layout still works when browser storage is unavailable. */
    }
    set({ bounds });
  },
  show: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
  togglePinned: () => set((state) => ({ pinned: !state.pinned })),
}));
