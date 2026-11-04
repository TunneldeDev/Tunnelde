import { create } from "zustand";
import type { FsSource } from "@/lib/api/types";

export interface PreviewFile {
  path: string;
  line: number;
  column: number;
  source: FsSource;
}

export const useFilePreview = create<{
  file: PreviewFile | null;
  show: (path: string, line?: number, column?: number, source?: FsSource) => void;
  close: () => void;
}>((set) => ({
  file: null,
  show: (path, line = 0, column = 0, source = { kind: "local" }) =>
    set({ file: { path, line, column, source } }),
  close: () => set({ file: null }),
}));
