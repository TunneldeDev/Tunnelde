import { create } from "zustand";

import type { PasteClip } from "@/lib/files/dnd";

interface FileClipboardStore {
  clip: PasteClip | null;
  set: (clip: PasteClip | null) => void;
  clear: () => void;
}

export const useFileClipboard = create<FileClipboardStore>((set) => ({
  clip: null,
  set: (clip) => set({ clip }),
  clear: () => set({ clip: null }),
}));
