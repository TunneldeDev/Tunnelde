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
  speedLimitKib?: number;
  fromHostId?: string | null;
  toHostId?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  fromPath?: string;
  toPath?: string;
}

interface TransfersStore {
  items: TransferItem[];
  apply: (event: TransferEvent) => void;
  cancel: (id: string) => void;
  hydrate: () => Promise<void>;
  pause: (id: string) => void;
  resume: (id: string) => void;
  clear: (id: string) => Promise<void>;
  setSpeedLimit: (id: string, kib: number) => Promise<boolean>;
}

const KEEP_FINISHED = 6;
let snapshotRequest = 0;

export const useTransfers = create<TransfersStore>((set, get) => ({
  items: [],
  setSpeedLimit: async (id, kib) => {
    const item = get().items.find((x) => x.id === id);
    if (!item || item.status !== "running" || item.cancelling || item.pausing || item.clearing)
      return false;
    try {
      await transferApi.setSpeedLimit(id, kib);
      set((state) => ({
        items: state.items.map((x) => (x.id === id ? { ...x, speedLimitKib: kib } : x)),
      }));
      return true;
    } catch (error) {
      toast(translateError(error), "error");
      return false;
    }
  },
  hydrate: async () => {
    if (!isTauri()) return;
    const request = ++snapshotRequest;
    const before = get().items;
    try {
      const rows = await transferApi.list();
      if (request !== snapshotRequest) return;
      set((state) => ({
        items: [
          ...state.items.filter(
            (x) => !rows.some((r) => r.id === x.id) && (!x.durable || !before.includes(x)),
          ),
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
              speedLimitKib: previous?.speedLimitKib,
              cancelling: item.status === "running" ? previous?.cancelling : undefined,
              pausing: item.status === "running" ? previous?.pausing : undefined,
              rate:
                item.status === "running"
                  ? (previous?.rate ?? sampleTransfer(undefined, item.transferred, Date.now()))
                  : undefined,
            };
          }),
        ],
      }));
    } catch (error) {
      if (request !== snapshotRequest) return;
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
      previous.status === "cancelled" ||
      previous.status === "cleanupPending" ||
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
              speedLimitKib: undefined,
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
  clear: async (id) => {
    const item = get().items.find((x) => x.id === id);
    if (!item || item.status === "running" || item.clearing) return;
    if (!item.durable) {
      set((state) => ({ items: state.items.filter((x) => x.id !== id) }));
      return;
    }
    set((state) => ({
      items: state.items.map((x) => (x.id === id ? { ...x, clearing: true } : x)),
    }));
    await transferApi
      .clear(id)
      .then((pending) =>
        set((state) => ({
          items: pending
            ? state.items.map((x) =>
                x.id === id
                  ? { ...x, ...pending, durable: true, clearing: false, rate: undefined }
                  : x,
              )
            : state.items.filter((x) => x.id !== id),
        })),
      )
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
      next.speedLimitKib = previous?.speedLimitKib;
      next.fromHostId = previous?.fromHostId;
      next.toHostId = previous?.toHostId;
      next.fromAddress = previous?.fromAddress;
      next.toAddress = previous?.toAddress;
      next.fromPath = previous?.fromPath;
      next.toPath = previous?.toPath;
      next.total = Math.max(event.total, previous?.total ?? 0);
      if (event.status === "running") {
        next.cancelling = previous?.cancelling;
        next.pausing = previous?.pausing;
        // Resumed jobs emit an initial zero before verifying existing target bytes.
        next.transferred = Math.max(event.transferred, previous?.transferred ?? 0);
        next.rate = sampleTransfer(previous?.rate, next.transferred, next.updatedAt);
      }
      // Progress must not reorder rows while a user is clicking their controls.
      const merged = previous
        ? state.items.map((item) => (item.id === event.id ? next : item))
        : [...state.items, next];
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
