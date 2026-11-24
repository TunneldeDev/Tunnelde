import { create } from "zustand";
import type { DiagnosticEvent } from "@/lib/diagnostics";
import { claimErrorDetails } from "@/lib/api/errorDetails";

export type ToastVariant = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  action?: { label: string; onClick: () => void | Promise<void> };
  /** Safe diagnostic record; never the original exception or payload. */
  details?: DiagnosticEvent;
}

interface ToastStore {
  items: Toast[];
  push: (
    message: string,
    variant?: ToastVariant,
    action?: Toast["action"],
    details?: DiagnosticEvent,
  ) => void;
  dismiss: (id: string) => void;
  hold: (id: string) => void;
}

const LIFETIME_MS = 4200;
const timers = new Map<string, number>();

export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (message, variant = "info", action, diagnostic) => {
    const id = crypto.randomUUID();
    const details = variant === "error" ? (diagnostic ?? claimErrorDetails(message)) : undefined;
    set((state) => ({
      items: [...state.items, { id, message, variant, action, details }].slice(-4),
    }));
    if (!action) {
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id);
          set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
        }, LIFETIME_MS),
      );
    }
  },
  hold: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
  },
}));

export const toast = (
  message: string,
  variant: ToastVariant = "info",
  action?: Toast["action"],
  details?: DiagnosticEvent,
): void => {
  useToasts.getState().push(message, variant, action, details);
};
