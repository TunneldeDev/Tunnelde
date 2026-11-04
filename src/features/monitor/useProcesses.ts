import { useCallback, useEffect, useRef, useState } from "react";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { RemoteProcess } from "@/lib/api/types";
import { useSettings } from "@/store/settings";

interface Result {
  sessionId: string;
  items: RemoteProcess[] | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
}

const initial = { items: null, error: null, loading: false, updatedAt: null };

/** Schedule after completion, preserving rows and avoiding overlapping SSH requests. */
export function useProcesses(sessionId: string) {
  const [result, setResult] = useState<Result>({ sessionId, ...initial });
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const controls = useRef({ refresh: () => {}, reschedule: () => {} });

  useEffect(() => {
    let active = true;
    let busy = false;
    let timer: number | undefined;
    const interval = () => {
      const settings = useSettings.getState().settings;
      return Math.max(1000, settings.monitorIntervalMs, settings.lightweightMode ? 5000 : 0);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (active && !busy && !pausedRef.current && document.visibilityState === "visible") {
        timer = window.setTimeout(() => void tick(), interval());
      }
    };
    const tick = async (manual = false) => {
      if (
        !active ||
        busy ||
        (!manual && pausedRef.current) ||
        document.visibilityState !== "visible"
      )
        return;
      window.clearTimeout(timer);
      busy = true;
      setResult((old) => ({
        ...(old.sessionId === sessionId ? old : initial),
        sessionId,
        loading: true,
      }));
      try {
        const items = await api.remoteProcesses(sessionId);
        if (active)
          setResult({ sessionId, items, loading: false, error: null, updatedAt: Date.now() });
      } catch (cause) {
        if (active) setResult((old) => ({ ...old, loading: false, error: translateError(cause) }));
      } finally {
        busy = false;
        schedule();
      }
    };
    controls.current = { refresh: () => void tick(true), reschedule: schedule };
    const visibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void tick();
    };
    const unsubscribe = useSettings.subscribe((state, old) => {
      if (
        state.settings.monitorIntervalMs !== old.settings.monitorIntervalMs ||
        state.settings.lightweightMode !== old.settings.lightweightMode
      )
        schedule();
    });
    document.addEventListener("visibilitychange", visibility);
    timer = window.setTimeout(() => void tick(), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      unsubscribe();
    };
  }, [sessionId]);

  const refresh = useCallback(() => controls.current.refresh(), []);
  const togglePaused = useCallback(() => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    controls.current.reschedule();
    if (!pausedRef.current) controls.current.refresh();
  }, []);
  return { ...(result.sessionId === sessionId ? result : initial), paused, refresh, togglePaused };
}
