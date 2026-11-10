import { Cpu, Gauge, HardDrive, MemoryStick, Network, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RemoteStats } from "@/lib/api/types";
import { formatBytes, formatPercent, formatUptime } from "@/lib/text/format";
import type { MonitorSample } from "@/store/monitorHistory";
import { MonitorChart } from "../MonitorChart";

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

interface CardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  meter?: number;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

function Card({ icon, label, value, detail, meter, action, children }: CardProps) {
  return (
    <div className="panel-card">
      <div className="panel-card__head">
        <span className="panel-card__label">
          {icon}
          {label}
        </span>
        <span className="panel-card__right">
          {action}
          <span className="panel-card__value">{value}</span>
        </span>
      </div>
      {meter === undefined ? null : <Meter value={meter} />}
      {detail ? <p className="panel-card__detail">{detail}</p> : null}
      {children}
    </div>
  );
}

export function MonitorPanelMetrics({
  stats,
  samples,
}: {
  stats: RemoteStats | null;
  samples: MonitorSample[];
}) {
  const { t } = useTranslation();
  const load = stats?.load ?? [0, 0, 0];
  const memoryPercent =
    stats && stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0;
  const diskPercent = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0;
  return (
    <div className="monitor-panel-metrics">
      <Card
        icon={<Cpu size={12} />}
        label={t("panel.cpu")}
        value={stats ? formatPercent(stats.cpuPercent) : "—"}
        detail={
          stats && stats.cpuCount > 0 ? t("panel.cores", { count: stats.cpuCount }) : undefined
        }
      >
        <MonitorChart samples={samples} kind="cpu" label={t("panel.cpu")} />
      </Card>

      <Card
        icon={<MemoryStick size={12} />}
        label={t("panel.memory")}
        value={stats ? formatPercent(memoryPercent) : "—"}
        detail={
          stats ? `${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)}` : undefined
        }
      >
        <MonitorChart samples={samples} kind="memory" label={t("panel.memory")} />
      </Card>

      <Card
        icon={<HardDrive size={12} />}
        label={t("panel.disk")}
        value={stats ? formatPercent(diskPercent) : "—"}
        meter={stats ? diskPercent : undefined}
        detail={
          stats ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}` : undefined
        }
      />

      <Card
        icon={<Network size={12} />}
        label={t("panel.network")}
        value={stats ? `↓ ${formatBytes(stats.netRxRate)}/s` : "—"}
        detail={stats ? `↑ ${formatBytes(stats.netTxRate)}/s` : undefined}
      >
        <MonitorChart samples={samples} kind="network" label={t("panel.network")} />
      </Card>

      <Card
        icon={<HardDrive size={12} />}
        label={t("monitor.diskIo")}
        value={stats?.diskReadRate != null ? `↓ ${formatBytes(stats.diskReadRate)}/s` : "—"}
        detail={
          stats?.diskWriteRate != null ? `↑ ${formatBytes(stats.diskWriteRate)}/s` : undefined
        }
      >
        <MonitorChart samples={samples} kind="disk" label={t("monitor.diskIo")} />
      </Card>

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
    </div>
  );
}
