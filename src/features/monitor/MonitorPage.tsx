import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/display/Misc";
import { useRemoteMonitor } from "./runtime/sampling";
import { useMonitor } from "@/store/monitor";
import { useMonitorHistory, type MonitorSample } from "@/store/monitorHistory";
import { useSsh } from "@/store/ssh";
import { MonitorCharts } from "./components/MonitorCharts";
import { MonitorSurface } from "./components/MonitorSurface";

const EMPTY: MonitorSample[] = [];

export function MonitorPage({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const { t } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const samples = useMonitorHistory((state) => state.samples[sessionId] ?? EMPTY);
  const entry = useMonitor((state) => state.entries[sessionId]);
  useRemoteMonitor(sessionId, active && session !== null);
  if (!session)
    return (
      <div className="page">
        <EmptyState title={t("sftp.noSession")} />
      </div>
    );
  return (
    <div className="monitor-page">
      <header className="monitor-head">
        <span className="monitor-head__title" title={session.title}>
          {session.title}
        </span>
        <span className="monitor-head__meta" title={session.address}>
          {session.address}
        </span>
        <span className="monitor-head__live">
          <span className="monitor-dot" aria-hidden="true" />
          {t("monitor.live", { count: samples.length })}
        </span>
      </header>
      {entry?.error ? <p className="panel__error">{entry.error}</p> : null}
      <MonitorSurface session={session} samples={samples} entry={entry} visible={active}>
        <MonitorCharts samples={samples} />
      </MonitorSurface>
    </div>
  );
}
