// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useState } from "react";

import { api, isTauri } from "@/lib/api/ipc";
import type { SystemStats } from "@/lib/api/types";

/**
 * Polls local machine stats only while the window is visible, so a hidden
 * window costs nothing.
 */
export function useSystemStats(intervalMs = 3000): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      if (!cancelled && document.visibilityState === "visible" && isTauri()) {
        try {
          const next = await api.systemStats();
          if (!cancelled) {
            setStats(next);
          }
        } catch {
          // Stats are decorative; never interrupt the workspace for them.
        }
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, intervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [intervalMs]);

  return stats;
}
