import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { RemoteStats } from "@/lib/api/types";
import { useMonitorHistory } from "@/store/monitorHistory";

export interface MonitorEntry {
  stats: RemoteStats | null;
  error: string | null;
}

const EMPTY: MonitorEntry = { stats: null, error: null };
const pending = new Map<string, Promise<void>>();
const versions = new Map<string, number>();

interface MonitorStore {
  entries: Record<string, MonitorEntry>;
  sample: (sessionId: string) => Promise<void>;
  forget: (sessionId: string) => void;
}

export const useMonitor = create<MonitorStore>((set) => ({
  entries: {},

  sample: (sessionId) => {
    const existing = pending.get(sessionId);
    if (existing) {
      return existing;
    }
    const version = versions.get(sessionId) ?? 0;
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
              [sessionId]: { stats, error: null },
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
            },
          },
        }));
      }
    })().finally(() => {
      if (pending.get(sessionId) === request) {
        pending.delete(sessionId);
      }
    });
    pending.set(sessionId, request);
    return request;
  },

  forget: (sessionId) => {
    versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
    pending.delete(sessionId);
    useMonitorHistory.getState().clear(sessionId);
    set((state) => {
      const next = { ...state.entries };
      delete next[sessionId];
      return { entries: next };
    });
  },
}));
