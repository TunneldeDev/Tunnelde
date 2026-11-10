import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import { createMonitorContext } from "@/lib/extensions/monitor/context";
import type { SshSession } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useMonitor, type MonitorEntry } from "@/store/monitor";
import { useMonitorHistory, type MonitorSample } from "@/store/monitorHistory";
import { refreshRemoteMonitor } from "../runtime/sampling";

/** Rendering may change; the host page retains sampling and its shared history. */
export function MonitorSurface({
  session,
  samples,
  entry,
  visible,
  presentation = "page",
  children,
}: {
  session: SshSession;
  samples: MonitorSample[];
  entry: MonitorEntry | undefined;
  visible: boolean;
  presentation?: "page" | "panel";
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Charts = surface.Mount;
  const frame = useMemo(
    () => ({
      sessionId: session.id,
      hostId: session.hostId,
      title: session.title,
      revision: crypto.randomUUID(),
      presentation,
      latest: entry?.stats
        ? {
            cpuCount: entry.stats.cpuCount,
            memoryUsed: entry.stats.memoryUsed,
            memoryTotal: entry.stats.memoryTotal,
            swapUsed: entry.stats.swapUsed,
            swapTotal: entry.stats.swapTotal,
            diskUsed: entry.stats.diskUsed,
            diskTotal: entry.stats.diskTotal,
            uptime: entry.stats.uptime,
            load: entry.stats.load,
          }
        : null,
      total: samples.length,
      sampling: visible,
      busy: entry?.loading ?? false,
      error: entry?.error ?? null,
    }),
    [session.id, session.hostId, session.title, samples, visible, entry, presentation],
  );
  const committed = useRef<object | null>(null);
  useLayoutEffect(() => {
    committed.current = frame;
    return () => {
      committed.current = null;
    };
  }, [frame]);
  /* eslint-disable react-hooks/refs -- Context factories retain, never execute callbacks during render. */
  const context = useMemo(
    () =>
      Object.freeze({
        Charts,
        ...createMonitorContext(
          frame,
          samples,
          () =>
            committed.current === frame &&
            useSsh
              .getState()
              .sessions.some((item) => item.id === session.id && item.hostId === session.hostId) &&
            useMonitor.getState().entries[session.id] === entry &&
            (useMonitorHistory.getState().samples[session.id] ?? samples) === samples,
          () => refreshRemoteMonitor(session.id),
        ),
      }),
    [Charts, frame, samples, session.id, session.hostId, entry],
  );
  /* eslint-enable react-hooks/refs */
  return (
    <div className="monitor-surface">
      <ProviderSurface target="monitor" monitor={context} visible={visible}>
        <Charts />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </div>
  );
}
