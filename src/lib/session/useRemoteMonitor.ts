// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect } from "react";

import { useMonitor } from "@/store/monitor";

interface Poller {
  consumers: number;
  timer: number | undefined;
  busy: boolean;
  tick: () => Promise<void>;
  visibility: () => void;
}

const pollers = new Map<string, Poller>();

/** One completion-based polling loop per session, shared by visible consumers. */
export function subscribeRemoteMonitor(sessionId: string): () => void {
  let poller = pollers.get(sessionId);
  if (!poller) {
    const next: Poller = {
      consumers: 0,
      timer: undefined,
      busy: false,
      tick: async () => {
        if (
          next.busy ||
          pollers.get(sessionId) !== next ||
          document.visibilityState !== "visible"
        ) {
          return;
        }
        window.clearTimeout(next.timer);
        next.busy = true;
        await useMonitor.getState().sample(sessionId);
        next.busy = false;
        if (pollers.get(sessionId) === next && document.visibilityState === "visible") {
          next.timer = window.setTimeout(() => void next.tick(), 2000);
        }
      },
      visibility: () => {
        window.clearTimeout(next.timer);
        if (document.visibilityState === "visible") {
          void next.tick();
        }
      },
    };
    poller = next;
    pollers.set(sessionId, next);
    document.addEventListener("visibilitychange", next.visibility);
    void next.tick();
  }
  poller.consumers += 1;
  const current = poller;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    current.consumers -= 1;
    if (current.consumers === 0) {
      window.clearTimeout(current.timer);
      document.removeEventListener("visibilitychange", current.visibility);
      pollers.delete(sessionId);
    }
  };
}

export function useRemoteMonitor(sessionId: string, enabled: boolean): void {
  useEffect(() => {
    if (enabled) {
      return subscribeRemoteMonitor(sessionId);
    }
  }, [enabled, sessionId]);
}
