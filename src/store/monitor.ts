import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { RemoteStats } from "@/lib/api/types";
import { useMonitorHistory } from "@/store/monitorHistory";

export interface MonitorEntry {
  stats: RemoteStats | null;
  error: string | null;
  loading?: boolean;
}

const EMPTY: MonitorEntry = { stats: null, error: null };
const pending = new Map<string, { version: number; promise: Promise<void> }>();
const versions = new Map<string, number>();

interface MonitorStore {
  entries: Record<string, MonitorEntry>;
  sample: (sessionId: string) => Promise<void>;
  retire: (sessionId: string) => void;
  forget: (sessionId: string) => void;
}

export const useMonitor = create<MonitorStore>((set, get) => ({
  entries: {},

  sample: (sessionId): Promise<void> => {
    const version = versions.get(sessionId) ?? 0;
    const existing = pending.get(sessionId);
    if (existing) {
      if (existing.version === version) return existing.promise;
      // A newly visible owner waits for a retired transport, then samples afresh.
      // If that owner also leaves while waiting, do not start hidden work.
      return existing.promise.then(() => {
        if ((versions.get(sessionId) ?? 0) === version) return get().sample(sessionId);
      });
    }
    set((state) => ({
      entries: {
        ...state.entries,
        [sessionId]: { ...(state.entries[sessionId] ?? EMPTY), loading: true },
      },
    }));
    const request = (async () => {
      try {
        const stats = await api.remoteStats(sessionId);
        if ((versions.get(sessionId) ?? 0) !== version) {
          return;
        }
        set((state) => {
          return {
            entries: {
              ...state.entries,
              [sessionId]: { stats, error: null, loading: false },
            },
          };
        });
        useMonitorHistory.getState().push(sessionId, {
          at: stats.sampledAt,
          cpu: stats.cpuPercent,
          memory: stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0,
          disk: stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0,
          rx: stats.netRxRate,
          tx: stats.netTxRate,
          diskRead: stats.diskReadRate ?? null,
          diskWrite: stats.diskWriteRate ?? null,
        });
      } catch (error) {
        if ((versions.get(sessionId) ?? 0) !== version) {
          return;
        }
        set((state) => ({
          entries: {
            ...state.entries,
            [sessionId]: {
              ...(state.entries[sessionId] ?? EMPTY),
              error: translateError(error),
              loading: false,
            },
          },
        }));
      }
    })().finally(() => {
      if (pending.get(sessionId)?.promise === request) {
        pending.delete(sessionId);
      }
    });
    pending.set(sessionId, { version, promise: request });
    return request;
  },

  retire: (sessionId) => {
    versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
    set((state) => {
      const entry = state.entries[sessionId];
      return entry?.loading
        ? { entries: { ...state.entries, [sessionId]: { ...entry, loading: false } } }
        : state;
    });
  },

  forget: (sessionId) => {
    get().retire(sessionId);
    useMonitorHistory.getState().clear(sessionId);
    set((state) => {
      const next = { ...state.entries };
      delete next[sessionId];
      return { entries: next };
    });
  },
}));
