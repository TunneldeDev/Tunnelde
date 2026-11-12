import { create } from "zustand";
import { captureFileTarget } from "@/lib/files/resources/target";
import type { FsSource } from "@/lib/api/types";

export interface PreviewFile {
  path: string;
  line: number;
  column: number;
  source: FsSource;
}

export const useFilePreview = create<{
  file: PreviewFile | null;
  id: string | null;
  show: (path: string, line?: number, column?: number, source?: FsSource) => void;
  close: () => void;
}>((set) => ({
  file: null,
  id: null,
  show: (path, line = 0, column = 0, source = { kind: "local" }) =>
    set({
      id: crypto.randomUUID(),
      file: {
        ...captureFileTarget(path, source),
        line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
        column: Number.isSafeInteger(column) && column >= 0 ? column : 0,
      },
    }),
  close: () => set({ file: null, id: null }),
}));
