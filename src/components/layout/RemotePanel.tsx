// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  Timer,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/Button";
import { formatBytes, formatPercent, formatUptime } from "@/lib/format";
import { useMonitor } from "@/store/monitor";
import { useSsh } from "@/store/ssh";

function Meter({ value }: { value: number }) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div
      className="td-meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <div
        className="td-meter__fill"
        style={{ width: `${clamped}%` }}
        data-tone={clamped >= 90 ? "red" : clamped >= 70 ? "orange" : "accent"}
      />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="sparkline" aria-hidden="true" />;
  }
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 26 - (Math.min(100, Math.max(0, value)) / 100) * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface CardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  meter?: number;
  children?: React.ReactNode;
}

function Card({ icon, label, value, detail, meter, children }: CardProps) {
  return (
    <div className="panel-card">
      <div className="panel-card__head">
        <span className="panel-card__label">
          {icon}
          {label}
        </span>
        <span className="panel-card__value">{value}</span>
      </div>
      {meter === undefined ? null : <Meter value={meter} />}
      {detail ? <p className="panel-card__detail">{detail}</p> : null}
      {children}
    </div>
  );
}

interface RemotePanelProps {
  sessionId: string;
  width: number;
  onHide: () => void;
}

export function RemotePanel({ sessionId, width, onHide }: RemotePanelProps) {
  const { t } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const entry = useMonitor((state) => state.entries[sessionId]);
  const sample = useMonitor((state) => state.sample);

  useEffect(() => {
    void sample(sessionId);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void sample(sessionId);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [sessionId, sample]);

  const stats = entry?.stats ?? null;
  const load = stats?.load ?? [0, 0, 0];
  const memoryPercent =
    stats && stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0;
  const diskPercent = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0;

  return (
    <aside className="panel" style={{ width }} aria-label={t("panel.remote")}>
      <header className="panel__head">
        <span className="panel__title">
          {t("panel.remote")}
          {session ? <span className="panel__subject">{session.title}</span> : null}
        </span>
        <IconButton label={t("panel.hide")} size="sm" onClick={onHide}>
          <X size={13} />
        </IconButton>
      </header>

      <div className="panel__body">
        {entry?.error ? <p className="panel__error">{entry.error}</p> : null}

        <Card
          icon={<Cpu size={12} />}
          label={t("panel.cpu")}
          value={stats ? formatPercent(stats.cpuPercent) : "—"}
          detail={stats && stats.cpuCount > 0 ? t("panel.cores", { count: stats.cpuCount }) : undefined}
        >
          <Sparkline values={entry?.cpuHistory ?? []} />
        </Card>

        <Card
          icon={<MemoryStick size={12} />}
          label={t("panel.memory")}
          value={stats ? formatPercent(memoryPercent) : "—"}
          meter={stats ? memoryPercent : undefined}
          detail={stats ? `${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)}` : undefined}
        />

        <Card
          icon={<HardDrive size={12} />}
          label={t("panel.disk")}
          value={stats ? formatPercent(diskPercent) : "—"}
          meter={stats ? diskPercent : undefined}
          detail={stats ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}` : undefined}
        />

        <Card
          icon={<Network size={12} />}
          label={t("panel.network")}
          value={
            stats
              ? `↓ ${formatBytes(stats.netRxRate)}/s`
              : "—"
          }
          detail={stats ? `↑ ${formatBytes(stats.netTxRate)}/s` : undefined}
        />

        <div className="panel-grid">
          <Card
            icon={<Timer size={12} />}
            label={t("panel.uptime")}
            value={stats ? formatUptime(stats.uptime) : "—"}
          />
          <Card
            icon={<Gauge size={12} />}
            label={t("panel.load")}
            value={stats ? load[0].toFixed(2) : "—"}
            detail={stats ? `${load[1].toFixed(2)}  ${load[2].toFixed(2)}` : undefined}
          />
        </div>

        <div className="panel-card">
          <div className="panel-card__head">
            <span className="panel-card__label">
              <Activity size={12} />
              {t("panel.topProcesses")}
            </span>
          </div>
          <div className="proc-list">
            {stats && stats.processes.length > 0 ? (
              stats.processes.map((process) => (
                <div key={`${process.pid}-${process.name}`} className="proc-row">
                  <span className="proc-row__name" title={process.name}>
                    {process.name}
                  </span>
                  <span className="proc-row__cpu">{formatPercent(process.cpu)}</span>
                </div>
              ))
            ) : (
              <p className="panel-card__detail">{t("panel.waiting")}</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
