import { create } from "zustand";

export interface SearchRoot {
  id: string;
  path: string;
  sessionId: string | null;
  tabId?: string;
}
export const useSearchRoots = create<{
  roots: Record<string, SearchRoot[]>;
  publish: (id: string, roots: SearchRoot[]) => void;
  remove: (id: string) => void;
}>((set) => ({
  roots: {},
  publish: (id, roots) => set((state) => ({ roots: { ...state.roots, [id]: roots } })),
  remove: (id) =>
    set((state) => ({
      roots: Object.fromEntries(Object.entries(state.roots).filter(([key]) => key !== id)),
    })),
}));
