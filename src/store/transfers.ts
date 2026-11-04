import { transferApi } from "@/lib/api/transfers";
import { isTauri } from "@/lib/api/ipc";
import { create } from "zustand";

import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import type { TransferEvent } from "@/lib/api/types";
import { sampleTransfer, type TransferRate } from "@/lib/files/transferProgress";

export interface TransferItem extends Omit<TransferEvent, "status"> {
  status: TransferEvent["status"] | "paused";
  durable?: boolean;
  updatedAt: number;
  cancelling?: boolean;
  pausing?: boolean;
  clearing?: boolean;
  rate?: TransferRate;
}

interface TransfersStore {
  items: TransferItem[];
  apply: (event: TransferEvent) => void;
  cancel: (id: string) => void;
  hydrate: () => Promise<void>;
  pause: (id: string) => void;
  resume: (id: string) => void;
  clear: (id: string) => void;
}

const KEEP_FINISHED = 6;

export const useTransfers = create<TransfersStore>((set, get) => ({
  items: [],
  hydrate: async () => {
    if (!isTauri()) return;
    try {
      const rows = await transferApi.list();
      set((state) => ({
        items: [
          ...state.items.filter((x) => !rows.some((r) => r.id === x.id)),
          ...rows.map((row) => {
            const previous = state.items.find((x) => x.id === row.id);
            const newer =
              previous &&
              (previous.updatedAt > row.updatedAt ||
                (previous.updatedAt === row.updatedAt &&
                  previous.status !== "running" &&
                  row.status === "running"));
            const item = newer ? previous : row;
            return {
              ...item,
              durable: true,
              clearing: previous?.clearing,
              pausing: previous?.pausing,
              rate:
                item.status === "running"
                  ? (previous?.rate ?? sampleTransfer(undefined, item.transferred, Date.now()))
                  : undefined,
            };
          }),
        ],
      }));
    } catch (error) {
      toast(translateError(error), "error");
    }
  },
  pause: (id) => {
    const item = get().items.find((x) => x.id === id);
    if (!item || item.status !== "running" || item.pausing || item.cancelling || item.clearing)
      return;
    set((state) => ({
      items: state.items.map((x) => (x.id === id ? { ...x, pausing: true } : x)),
    }));
    void transferApi.pause(id).catch((error) => {
      set((state) => ({
        items: state.items.map((x) => (x.id === id ? { ...x, pausing: false } : x)),
      }));
      toast(translateError(error), "error");
    });
  },
  resume: (id) => {
    const previous = get().items.find((x) => x.id === id);
    if (
      !previous ||
      previous.status === "running" ||
      previous.clearing ||
      previous.status === "done"
    )
      return;
    set((state) => ({
      items: state.items.map((x) =>
        x.id === id
          ? {
              ...x,
              status: "running",
              cancelling: false,
              pausing: false,
              error: null,
              rate: sampleTransfer(undefined, x.transferred, Date.now()),
            }
          : x,
      ),
    }));
    void transferApi.resume(id).catch((error) => {
      set((state) => ({
        items: state.items.map((x) => (x.id === id && x.status === "running" ? previous : x)),
      }));
      toast(translateError(error), "error");
    });
  },
  clear: (id) => {
    const item = get().items.find((x) => x.id === id);
    if (!item || item.status === "running" || item.clearing) return;
    set((state) => ({
      items: state.items.map((x) => (x.id === id ? { ...x, clearing: true } : x)),
    }));
    void transferApi
      .clear(id)
      .then(() => set((state) => ({ items: state.items.filter((x) => x.id !== id) })))
      .catch((error) => {
        set((state) => ({
          items: state.items.map((x) => (x.id === id ? { ...x, clearing: false } : x)),
        }));
        toast(translateError(error), "error");
      });
  },

  apply: (event) => {
    const next: TransferItem = { ...event, updatedAt: Date.now() };
    set((state) => {
      const previous = state.items.find((item) => item.id === event.id);
      if (previous && previous.status !== "running" && event.status === "running") return state;
      next.durable = previous?.durable;
      next.clearing = previous?.clearing;
      next.total = Math.max(event.total, previous?.total ?? 0);
      if (event.status === "running") {
        next.cancelling = previous?.cancelling;
        next.pausing = previous?.pausing;
        // Resumed jobs emit an initial zero before verifying existing target bytes.
        next.transferred = Math.max(event.transferred, previous?.transferred ?? 0);
        next.rate = sampleTransfer(previous?.rate, next.transferred, next.updatedAt);
      }
      const others = state.items.filter((item) => item.id !== event.id);
      const merged = [...others, next].sort((left, right) => left.updatedAt - right.updatedAt);
      const finished = merged.filter((item) => !item.durable && item.status !== "running");
      const running = merged.filter((item) => item.durable || item.status === "running");
      const trimmed = [...running, ...finished.slice(-KEEP_FINISHED)];
      return { items: trimmed };
    });
  },

  cancel: (id) => {
    const item = get().items.find((entry) => entry.id === id);
    if (item && item.status === "running" && !item.cancelling && !item.pausing && !item.clearing) {
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
