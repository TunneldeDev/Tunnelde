// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/Misc";
import { translateError } from "@/lib/errors";
import { formatBytes, formatPercent } from "@/lib/format";
import { api } from "@/lib/ipc";
import { summarize, useMonitorHistory, type MonitorSample } from "@/store/monitorHistory";
import { useSsh } from "@/store/ssh";

const EMPTY: MonitorSample[] = [];

interface ChartProps {
  values: number[];
  ceiling: number;
  tone: "accent" | "green" | "orange";
}

function Chart({ values, ceiling, tone }: ChartProps) {
  const limit = ceiling > 0 ? ceiling : 1;
  const points = values.map((value, index) => {
    const x = values.length > 1 ? (index / (values.length - 1)) * 100 : 0;
    const y = 30 - Math.min(1, Math.max(0, value / limit)) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      className={`chart chart--${tone}`}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {points.length > 1 ? (
        <>
          <polygon points={`0,30 ${points.join(" ")} 100,30`} className="chart__area" />
          <polyline
            points={points.join(" ")}
            className="chart__line"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
    </svg>
  );
}

interface MetricProps {
  label: string;
  value: string;
  caption: string;
  values: number[];
  ceiling: number;
  tone: "accent" | "green" | "orange";
}

function Metric({ label, value, caption, values, ceiling, tone }: MetricProps) {
  return (
    <article className="monitor-card">
      <header className="monitor-card__head">
        <span className="monitor-card__label">{label}</span>
        <span className="monitor-card__value">{value}</span>
      </header>
      <Chart values={values} ceiling={ceiling} tone={tone} />
      <p className="monitor-card__caption">{caption}</p>
    </article>
  );
}

export function MonitorPage({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const samples = useMonitorHistory((state) => state.samples[sessionId] ?? EMPTY);
  const push = useMonitorHistory((state) => state.push);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .remoteStats(sessionId)
        .then((stats) => {
          if (!alive) {
            return;
          }
          setError(null);
          push(sessionId, {
            at: stats.sampledAt,
            cpu: stats.cpuPercent,
            memory: stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0,
            disk: stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0,
            rx: stats.netRxRate,
            tx: stats.netTxRate,
          });
        })
        .catch((cause: unknown) => {
          if (alive) {
            setError(translateError(cause));
          }
        });
    };

    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [sessionId, push]);

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
  const rateCeiling = Math.max(rateSummary.max, 1024);

  const percentCaption = (summary: typeof cpuSummary) =>
    `${t("monitor.average")} ${formatPercent(summary.average)} · ${t("monitor.peak")} ${formatPercent(summary.max)}`;

  return (
    <div className="monitor-page">
      <header className="monitor-head">
        <span className="monitor-head__title">{session.title}</span>
        <span className="monitor-head__meta">{session.address}</span>
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
          values={cpu}
          ceiling={100}
          tone="accent"
        />
        <Metric
          label={t("panel.memory")}
          value={formatPercent(last?.memory ?? 0)}
          caption={percentCaption(memorySummary)}
          values={memory}
          ceiling={100}
          tone="green"
        />
        <Metric
          label={t("panel.network")}
          value={last ? `${formatBytes(last.rx + last.tx)}/s` : "—"}
          caption={`${t("monitor.average")} ${formatBytes(rateSummary.average)}/s · ${t("monitor.peak")} ${formatBytes(rateSummary.max)}/s`}
          values={rates}
          ceiling={rateCeiling}
          tone="orange"
        />
      </div>
    </div>
  );
}
