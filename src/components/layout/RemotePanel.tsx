import { Activity, List, Maximize2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { ProcessesDialog } from "@/features/monitor/ProcessesDialog";
import { cn, formatPercent } from "@/lib/text/format";
import { useMonitor } from "@/store/monitor";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useRemoteMonitor } from "@/features/monitor/runtime/sampling";
import { MonitorSurface } from "@/features/monitor/components/MonitorSurface";
import { MonitorPanelMetrics } from "@/features/monitor/components/MonitorPanelMetrics";
import { useMonitorHistory, type MonitorSample } from "@/store/monitorHistory";

const EMPTY_SAMPLES: MonitorSample[] = [];

interface RemotePanelProps {
  hidden?: boolean;
  sessionId: string;
  width: number;
  onHide: () => void;
}

export function RemotePanel({ sessionId, width, onHide, hidden }: RemotePanelProps) {
  const { t } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const entry = useMonitor((state) => state.entries[sessionId]);
  const samples = useMonitorHistory((state) => state.samples[sessionId] ?? EMPTY_SAMPLES);
  const [processesOpen, setProcessesOpen] = useState(false);
  const openMonitor = useWorkspace((state) => state.openMonitor);
  useRemoteMonitor(sessionId, !hidden && session !== null);

  const stats = entry?.stats ?? null;

  return (
    <aside
      className={cn("panel", hidden && "is-collapsed")}
      style={{ width: `var(--td-panel-w, ${width}px)` }}
      aria-label={t("panel.remote")}
    >
      <header className="panel__head">
        <span className="panel__title">
          {t("panel.remote")}
          {session ? <span className="panel__subject">{session.title}</span> : null}
        </span>
        <span className="panel__actions">
          <IconButton
            label={t("monitor.open")}
            size="sm"
            disabled={!session}
            onClick={() => session && openMonitor(session)}
          >
            <Maximize2 size={12} />
          </IconButton>
          <IconButton label={t("panel.hide")} size="sm" onClick={onHide}>
            <X size={13} />
          </IconButton>
        </span>
      </header>

      <div className="panel__body">
        {entry?.error ? <p className="panel__error">{entry.error}</p> : null}

        {session ? (
          <MonitorSurface
            session={session}
            samples={samples}
            entry={entry}
            visible={!hidden}
            presentation="panel"
          >
            <MonitorPanelMetrics stats={stats} samples={samples} />
          </MonitorSurface>
        ) : (
          <MonitorPanelMetrics stats={stats} samples={samples} />
        )}

        <div className="panel-card">
          <div className="panel-card__head">
            <span className="panel-card__label">
              <Activity size={12} />
              {t("panel.topProcesses")}
            </span>
            <IconButton
              label={t("processes.title")}
              size="sm"
              onClick={() => setProcessesOpen(true)}
            >
              <List size={12} />
            </IconButton>
          </div>
          <div className="proc-list">
            {stats && stats.processes.length > 0 ? (
              stats.processes.map((process) => (
                <div key={`${process.pid}-${process.name}`} className="proc-row">
                  <span className="proc-row__name" title={process.name}>
                    {process.name}
                  </span>
                  <span className="proc-row__cpu" title={t("processes.cpuHint")}>
                    {process.cpuTotal == null ? "—" : formatPercent(process.cpuTotal)}
                  </span>
                </div>
              ))
            ) : (
              <p className="panel-card__detail">{t("panel.waiting")}</p>
            )}
          </div>
        </div>
      </div>

      {processesOpen ? (
        <ProcessesDialog
          key={sessionId}
          sessionId={sessionId}
          onClose={() => setProcessesOpen(false)}
        />
      ) : null}
    </aside>
  );
}
