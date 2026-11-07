import { create } from "zustand";
import { api } from "@/lib/api/ipc";
import type { EditorCleanup } from "@/lib/api/types";

interface CleanupStore {
  items: EditorCleanup[];
  hydrate: () => Promise<void>;
  retry: (id: string) => Promise<void>;
}

let generation = 0;
export const useEditorCleanup = create<CleanupStore>((set, get) => ({
  items: [],
  hydrate: async () => {
    const request = ++generation;
    const items = await api.editorCleanupList();
    if (request === generation) set({ items });
  },
  retry: async (id) => {
    try {
      await api.editorCleanupRetry(id);
    } finally {
      await get().hydrate();
    }
  },
}));
