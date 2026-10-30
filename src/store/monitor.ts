// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { RemoteStats } from "@/lib/api/types";

const HISTORY = 60;

export interface MonitorEntry {
  stats: RemoteStats | null;
  cpuHistory: number[];
  error: string | null;
}

const EMPTY: MonitorEntry = { stats: null, cpuHistory: [], error: null };

interface MonitorStore {
  entries: Record<string, MonitorEntry>;
  sample: (sessionId: string) => Promise<void>;
  forget: (sessionId: string) => void;
}

export const useMonitor = create<MonitorStore>((set) => ({
  entries: {},

  sample: async (sessionId) => {
    try {
      const stats = await api.remoteStats(sessionId);
      set((state) => {
        const current = state.entries[sessionId] ?? EMPTY;
        const cpuHistory = [...current.cpuHistory, Math.round(stats.cpuPercent)].slice(-HISTORY);
        return {
          entries: {
            ...state.entries,
            [sessionId]: { stats, cpuHistory, error: null },
          },
        };
      });
    } catch (error) {
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
  },

  forget: (sessionId) => {
    set((state) => {
      const next = { ...state.entries };
      delete next[sessionId];
      return { entries: next };
    });
  },
}));
