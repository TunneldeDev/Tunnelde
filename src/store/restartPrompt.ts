import { create } from "zustand";
import type { StorageRestartPlan } from "@/lib/api/storage";

interface RestartPromptState {
  open: boolean;
  observed: string | null;
  observe: (plan: (Partial<StorageRestartPlan> & { id: string }) | null) => void;
  show: () => void;
  close: () => void;
}

export const useRestartPrompt = create<RestartPromptState>((set) => ({
  open: false,
  observed: null,
  observe: (plan) => {
    const observed = plan
      ? JSON.stringify([plan.id, plan.action ?? "apply", !!plan.restartRequested])
      : null;
    set((state) =>
      state.observed === observed && (observed !== null || !state.open)
        ? state
        : { observed, open: observed !== null },
    );
  },
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
