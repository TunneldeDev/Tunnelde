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

function samplingInterval() {
  const settings = useSettings.getState().settings;
  return Math.max(1000, settings.monitorIntervalMs, settings.lightweightMode ? 5000 : 0);
}

/** Refresh only an already-owned visible sampler, never create a hidden consumer. */
export function refreshRemoteMonitor(sessionId: string): void {
  const poller = pollers.get(sessionId);
  if (!poller || document.visibilityState !== "visible") throw new Error("plugin.monitor.inactive");
  void poller.tick();
}

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
            next.timer = window.setTimeout(() => void next.tick(), samplingInterval());
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
      if (
        state.settings.monitorIntervalMs === previous.settings.monitorIntervalMs &&
        state.settings.lightweightMode === previous.settings.lightweightMode
      )
        return;
      window.clearTimeout(next.timer);
      // A pending sample finishes first, then schedules with the latest value.
      if (!next.busy && document.visibilityState === "visible") {
        next.timer = window.setTimeout(() => void next.tick(), samplingInterval());
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
      // The transport can finish later; it must not publish a sample after its last owner left.
      useMonitor.getState().retire(sessionId);
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
