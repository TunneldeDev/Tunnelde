import { useTranslation } from "react-i18next";

import { formatBytes, formatPercent } from "@/lib/text/format";
import { summarize, type MonitorSample } from "@/store/monitorHistory";
import { MonitorChart } from "../MonitorChart";

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

export function MonitorCharts({ samples }: { samples: MonitorSample[] }) {
  const { t } = useTranslation();

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
  );
}
