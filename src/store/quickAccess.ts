import { create } from "zustand";

export const useQuickAccess = create<{
  query: string | null;
  generation: number;
  show: (query?: string) => void;
  close: () => void;
}>((set) => ({
  query: null,
  generation: 0,
  show: (query = ">") => set((state) => ({ query, generation: state.generation + 1 })),
  close: () => set((state) => ({ query: null, generation: state.generation + 1 })),
}));
