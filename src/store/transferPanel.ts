import { create } from "zustand";

export const useTransferPanel = create<{
  open: boolean;
  pinned: boolean;
  show: () => void;
  close: () => void;
  toggle: () => void;
  togglePinned: () => void;
}>((set) => ({
  open: false,
  pinned: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
  togglePinned: () => set((state) => ({ pinned: !state.pinned })),
}));
