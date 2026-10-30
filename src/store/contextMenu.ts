// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface ContextMenuStore {
  menu: MenuState | null;
  open: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useContextMenu = create<ContextMenuStore>((set) => ({
  menu: null,

  open: (x, y, items) => {
    if (items.length === 0) {
      set({ menu: null });
      return;
    }
    set({ menu: { x, y, items } });
  },

  close: () => set({ menu: null }),
}));
