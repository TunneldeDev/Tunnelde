// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

export const SAMPLE_LIMIT = 240;

export interface MonitorSample {
  at: number;
  cpu: number;
  memory: number;
  disk: number;
  rx: number;
  tx: number;
}

interface MonitorHistoryStore {
  samples: Record<string, MonitorSample[]>;
  push: (sessionId: string, sample: MonitorSample) => void;
  clear: (sessionId: string) => void;
}

export const useMonitorHistory = create<MonitorHistoryStore>((set) => ({
  samples: {},

  push: (sessionId, sample) => {
    set((state) => {
      const current = state.samples[sessionId] ?? [];
      return {
        samples: {
          ...state.samples,
          [sessionId]: [...current, sample].slice(-SAMPLE_LIMIT),
        },
      };
    });
  },

  clear: (sessionId) => {
    set((state) => {
      const next = { ...state.samples };
      delete next[sessionId];
      return { samples: next };
    });
  },
}));

export interface Summary {
  min: number;
  max: number;
  average: number;
}

export function summarize(values: number[]): Summary {
  if (values.length === 0) {
    return { min: 0, max: 0, average: 0 };
  }
  let min = values[0] ?? 0;
  let max = values[0] ?? 0;
  let total = 0;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    total += value;
  }
  return { min, max, average: total / values.length };
}
