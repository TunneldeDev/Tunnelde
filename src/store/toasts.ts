// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

export type ToastVariant = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastStore {
  items: Toast[];
  push: (message: string, variant?: ToastVariant) => void;
  dismiss: (id: string) => void;
}

const LIFETIME_MS = 4200;

export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (message, variant = "info") => {
    const id = crypto.randomUUID();
    set((state) => ({ items: [...state.items, { id, message, variant }].slice(-4) }));
    window.setTimeout(() => {
      set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
    }, LIFETIME_MS);
  },
  dismiss: (id) => {
    set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
  },
}));

export const toast = (message: string, variant: ToastVariant = "info"): void => {
  useToasts.getState().push(message, variant);
};
