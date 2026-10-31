// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Activity, Cpu, HardDrive, Layers, MemoryStick, Timer, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { cn, formatBytes, formatPercent, formatUptime } from "@/lib/text/format";
import { useSystemStats } from "@/lib/session/useSystemStats";
import type { SystemStats } from "@/lib/api/types";

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

function ratio(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

interface CardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  meter?: number;
  detail?: string;
}

function Card({ icon, label, value, meter, detail }: CardProps) {
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
    </div>
  );
}

interface SystemPanelProps {
  hidden?: boolean;
  width: number;
  onHide: () => void;
}

export function SystemPanel({ width, onHide, hidden }: SystemPanelProps) {
  const { t } = useTranslation();
  const stats: SystemStats | null = useSystemStats(3000, !hidden);
  const disk = stats?.disks[0];
  const load = stats?.loadAverage ?? [0, 0, 0];
  const hasLoad = load.some((value) => value > 0);

  return (
    <aside
      className={cn("panel", hidden && "is-collapsed")}
      style={{ width }}
      aria-label={t("panel.system")}
    >
      <header className="panel__head">
        <span className="panel__title">{t("panel.system")}</span>
        <IconButton label={t("panel.hide")} size="sm" onClick={onHide}>
          <X size={13} />
        </IconButton>
      </header>

      <div className="panel__body">
        <Card
          icon={<Cpu size={12} />}
          label={t("panel.cpu")}
          value={stats ? formatPercent(stats.cpuUsage) : "—"}
          meter={stats?.cpuUsage}
          detail={hasLoad ? load.map((value) => value.toFixed(2)).join("  ") : undefined}
        />
        <Card
          icon={<MemoryStick size={12} />}
          label={t("panel.memory")}
          value={stats ? formatPercent(ratio(stats.memoryUsed, stats.memoryTotal)) : "—"}
          meter={stats ? ratio(stats.memoryUsed, stats.memoryTotal) : undefined}
          detail={
            stats
              ? `${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)}`
              : undefined
          }
        />
        <Card
          icon={<HardDrive size={12} />}
          label={t("panel.disk")}
          value={disk ? formatPercent(ratio(disk.total - disk.available, disk.total)) : "—"}
          meter={disk ? ratio(disk.total - disk.available, disk.total) : undefined}
          detail={
            disk
              ? `${formatBytes(disk.total - disk.available)} / ${formatBytes(disk.total)}`
              : undefined
          }
        />
        <div className="panel-grid">
          <Card
            icon={<Timer size={12} />}
            label={t("panel.uptime")}
            value={stats ? formatUptime(stats.uptime) : "—"}
          />
          <Card
            icon={<Layers size={12} />}
            label={t("panel.processes")}
            value={stats ? String(stats.processCount) : "—"}
          />
        </div>
        <Card
          icon={<Activity size={12} />}
          label={t("panel.appMemory")}
          value={stats ? formatBytes(stats.appMemory) : "—"}
          detail={stats ? t("panel.processCount", { count: stats.appProcesses }) : undefined}
        />
      </div>
    </aside>
  );
}
