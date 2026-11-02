import { create } from "zustand";

export const useQuickAccess = create<{
  query: string | null;
  show: (query?: string) => void;
  close: () => void;
}>((set) => ({
  query: null,
  show: (query = ">") => set({ query }),
  close: () => set({ query: null }),
}));
