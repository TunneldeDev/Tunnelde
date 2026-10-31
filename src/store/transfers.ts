// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import type { TransferEvent } from "@/lib/api/types";

export interface TransferItem extends TransferEvent {
  updatedAt: number;
  cancelling?: boolean;
}

interface TransfersStore {
  items: TransferItem[];
  apply: (event: TransferEvent) => void;
  cancel: (id: string) => void;
}

const KEEP_FINISHED = 6;

export const useTransfers = create<TransfersStore>((set, get) => ({
  items: [],

  apply: (event) => {
    const next: TransferItem = { ...event, updatedAt: Date.now() };
    set((state) => {
      const previous = state.items.find((item) => item.id === event.id);
      if (previous && previous.status !== "running" && event.status === "running") return state;
      if (event.status === "running") next.cancelling = previous?.cancelling;
      const others = state.items.filter((item) => item.id !== event.id);
      const merged = [...others, next].sort((left, right) => left.updatedAt - right.updatedAt);
      const finished = merged.filter((item) => item.status !== "running");
      const running = merged.filter((item) => item.status === "running");
      const trimmed = [...running, ...finished.slice(-KEEP_FINISHED)];
      return { items: trimmed };
    });
  },

  cancel: (id) => {
    const item = get().items.find((entry) => entry.id === id);
    if (item && item.status === "running" && !item.cancelling) {
      set((state) => ({
        items: state.items.map((entry) =>
          entry.id === id ? { ...entry, cancelling: true } : entry,
        ),
      }));
      void api.transferCancel(id).catch((error: unknown) => {
        set((state) => ({
          items: state.items.map((entry) =>
            entry.id === id ? { ...entry, cancelling: false } : entry,
          ),
        }));
        toast(translateError(error), "error");
      });
    }
  },
}));
