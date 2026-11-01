// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect } from "react";

import { useMonitor } from "@/store/monitor";
import { useSettings } from "@/store/settings";

interface Poller {
  consumers: number;
  timer: number | undefined;
  busy: boolean;
  tick: () => Promise<void>;
  visibility: () => void;
  unsubscribeSettings: () => void;
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
      unsubscribeSettings: () => {},
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
        try {
          await useMonitor.getState().sample(sessionId);
        } finally {
          next.busy = false;
          if (pollers.get(sessionId) === next && document.visibilityState === "visible") {
            next.timer = window.setTimeout(
              () => void next.tick(),
              useSettings.getState().settings.monitorIntervalMs,
            );
          }
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
    next.unsubscribeSettings = useSettings.subscribe((state, previous) => {
      if (state.settings.monitorIntervalMs === previous.settings.monitorIntervalMs) return;
      window.clearTimeout(next.timer);
      // A pending sample finishes first, then schedules with the latest value.
      if (!next.busy && document.visibilityState === "visible") {
        next.timer = window.setTimeout(() => void next.tick(), state.settings.monitorIntervalMs);
      }
    });
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
      current.unsubscribeSettings();
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
