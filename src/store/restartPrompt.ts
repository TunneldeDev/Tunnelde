import { create } from "zustand";

interface RestartPromptState {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useRestartPrompt = create<RestartPromptState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
