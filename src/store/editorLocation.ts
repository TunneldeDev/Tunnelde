import { create } from "zustand";

export const useEditorLocation = create<{
  target: { tabId: string; line: number; column: number } | null;
  reveal: (tabId: string, line: number, column: number) => void;
  clear: () => void;
}>((set) => ({
  target: null,
  reveal: (tabId, line, column) => set({ target: { tabId, line, column } }),
  clear: () => set({ target: null }),
}));
