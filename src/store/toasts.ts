import { create } from "zustand";

export type ToastVariant = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  action?: { label: string; onClick: () => void | Promise<void> };
}

interface ToastStore {
  items: Toast[];
  push: (message: string, variant?: ToastVariant, action?: Toast["action"]) => void;
  dismiss: (id: string) => void;
}

const LIFETIME_MS = 4200;

export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (message, variant = "info", action) => {
    const id = crypto.randomUUID();
    set((state) => ({ items: [...state.items, { id, message, variant, action }].slice(-4) }));
    if (!action) {
      window.setTimeout(() => {
        set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
      }, LIFETIME_MS);
    }
  },
  dismiss: (id) => {
    set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
  },
}));

export const toast = (
  message: string,
  variant: ToastVariant = "info",
  action?: Toast["action"],
): void => {
  useToasts.getState().push(message, variant, action);
};
