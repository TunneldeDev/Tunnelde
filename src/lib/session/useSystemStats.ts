// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useState } from "react";

import { api, isTauri } from "@/lib/api/ipc";
import type { SystemStats } from "@/lib/api/types";

// Reuse a slow IPC request across visibility changes and component remounts.
let pending: Promise<SystemStats> | null = null;

function readStats(): Promise<SystemStats> {
  if (pending) return pending;
  const request = api.systemStats().finally(() => {
    if (pending === request) pending = null;
  });
  pending = request;
  return request;
}

/** Completion-based sampling while both the consumer and document are visible. */
export function useSystemStats(intervalMs = 3000, enabled = true): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let cancelled = false;
    let busy = false;
    let timer: number | undefined;

    const tick = async () => {
      if (cancelled || busy || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      busy = true;
      try {
        const next = await readStats();
        if (!cancelled && document.visibilityState === "visible") setStats(next);
      } catch {
        // Stats are decorative; never interrupt the workspace for them.
      } finally {
        busy = false;
        if (!cancelled && document.visibilityState === "visible") {
          timer = window.setTimeout(() => void tick(), intervalMs);
        }
      }
    };

    const visibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", visibility);
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, intervalMs]);

  return stats;
}
