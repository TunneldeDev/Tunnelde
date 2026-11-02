import { create } from "zustand";

export const useFilePreview = create<{
  file: { path: string; line: number; column: number } | null;
  show: (path: string, line: number, column: number) => void;
  close: () => void;
}>((set) => ({
  file: null,
  show: (path, line, column) => set({ file: { path, line, column } }),
  close: () => set({ file: null }),
}));
