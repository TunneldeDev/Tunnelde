import { create } from "zustand";

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  trigger?: HTMLElement | null;
}

interface ContextMenuStore {
  menu: MenuState | null;
  open: (x: number, y: number, items: MenuItem[], trigger?: HTMLElement | null) => void;
  close: (restoreFocus?: boolean) => void;
}

export const useContextMenu = create<ContextMenuStore>((set, get) => ({
  menu: null,

  open: (x, y, items, trigger) => {
    if (items.length === 0) {
      set({ menu: null });
      return;
    }
    const active = typeof document === "undefined" ? null : document.activeElement;
    const previousTrigger =
      active instanceof HTMLElement && active.closest('[role="menu"]')
        ? get().menu?.trigger
        : active;
    set({
      menu: {
        x,
        y,
        items,
        trigger: trigger ?? (previousTrigger instanceof HTMLElement ? previousTrigger : null),
      },
    });
  },

  close: (restoreFocus = true) => {
    const trigger = get().menu?.trigger;
    set({ menu: null });
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  },
}));
