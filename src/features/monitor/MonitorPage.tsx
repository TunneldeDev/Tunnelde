import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/display/Misc";
import { formatBytes, formatPercent } from "@/lib/text/format";
import { useRemoteMonitor } from "@/lib/session/useRemoteMonitor";
import { useMonitor } from "@/store/monitor";
import { summarize, useMonitorHistory, type MonitorSample } from "@/store/monitorHistory";
import { useSsh } from "@/store/ssh";
import { MonitorChart } from "./MonitorChart";

const EMPTY: MonitorSample[] = [];

interface MetricProps {
  label: string;
  value: string;
  caption: string;
  samples: MonitorSample[];
  kind: "cpu" | "memory" | "network" | "disk";
}

function Metric({ label, value, caption, samples, kind }: MetricProps) {
  return (
    <article className="monitor-card">
      <header className="monitor-card__head">
        <span className="monitor-card__label">{label}</span>
        <span className="monitor-card__value">{value}</span>
      </header>
      <MonitorChart samples={samples} kind={kind} label={label} />
      <p className="monitor-card__caption">{caption}</p>
    </article>
  );
}

export function MonitorPage({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const { t } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const samples = useMonitorHistory((state) => state.samples[sessionId] ?? EMPTY);
  const error = useMonitor((state) => state.entries[sessionId]?.error);
  useRemoteMonitor(sessionId, active && session !== null);

  if (!session) {
    return (
      <div className="page">
        <EmptyState title={t("sftp.noSession")} />
      </div>
    );
  }

  const last = samples[samples.length - 1];
  const cpu = samples.map((sample) => sample.cpu);
  const memory = samples.map((sample) => sample.memory);
  const rates = samples.map((sample) => sample.rx + sample.tx);
  const cpuSummary = summarize(cpu);
  const memorySummary = summarize(memory);
  const rateSummary = summarize(rates);
  const diskRates = samples.flatMap((sample) =>
    sample.diskRead !== null && sample.diskWrite !== null
      ? [sample.diskRead + sample.diskWrite]
      : [],
  );
  const diskSummary = summarize(diskRates);
  const rateCaption = (summary: typeof cpuSummary) =>
    `${t("monitor.average")} ${formatBytes(summary.average)}/s · ${t("monitor.peak")} ${formatBytes(summary.max)}/s`;

  const percentCaption = (summary: typeof cpuSummary) =>
    `${t("monitor.average")} ${formatPercent(summary.average)} · ${t("monitor.peak")} ${formatPercent(summary.max)}`;

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

      {error ? <p className="panel__error">{error}</p> : null}

      <div className="monitor-grid">
        <Metric
          label={t("panel.cpu")}
          value={formatPercent(last?.cpu ?? 0)}
          caption={percentCaption(cpuSummary)}
          samples={samples}
          kind="cpu"
        />
        <Metric
          label={t("panel.memory")}
          value={formatPercent(last?.memory ?? 0)}
          caption={percentCaption(memorySummary)}
          samples={samples}
          kind="memory"
        />
        <Metric
          label={t("panel.network")}
          value={last ? `${formatBytes(last.rx + last.tx)}/s` : "—"}
          caption={rateCaption(rateSummary)}
          samples={samples}
          kind="network"
        />
        <Metric
          label={t("monitor.diskIo")}
          value={
            last && last.diskRead !== null && last.diskWrite !== null
              ? `${formatBytes(last.diskRead + last.diskWrite)}/s`
              : "—"
          }
          caption={diskRates.length ? rateCaption(diskSummary) : t("monitor.unavailable")}
          samples={samples}
          kind="disk"
        />
      </div>
    </div>
  );
}
