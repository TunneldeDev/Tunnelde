import { useTranslation } from "react-i18next";
import type messages from "@/i18n/en-US.json";
import type { ReactNode } from "react";
import type { RemoteStats } from "@/lib/api/types";
import { formatBytes, formatPercent, formatUptime } from "@/lib/text/format";
import "../performance.css";

function Reading({ children, rows }: { children?: ReactNode; rows: [string, ReactNode][] }) {
  return (
    <>
      {children}
      <dl className="performance-readings">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
const finite = (v: number | null | undefined) => v != null && Number.isFinite(v) && v >= 0;
const bytes = (v: number | null | undefined) => (finite(v) ? formatBytes(v!) : "—");
const count = (v: number | null | undefined) => (finite(v) ? v!.toLocaleString() : "—");
const rate = (v: number | null | undefined) => (finite(v) ? `${formatBytes(v!)}/s` : "—");
const percent = (v: number | null | undefined) => (finite(v) ? formatPercent(v!) : "—");

/** Shared by the monitor page and panel. Every value comes from the current remote sample. */
export function PerformanceDetails({ stats }: { stats: RemoteStats | null }) {
  const { t } = useTranslation();
  const d = stats?.details;
  const label = (key: keyof typeof messages.performance) => t(`performance.${key}`);
  const mhz = (value: number | null | undefined) =>
    finite(value) ? `${(value! / 1000).toFixed(2)} GHz` : "—";
  return (
    <div className="performance-details">
      <section className="performance-section" aria-label={label("cpuDetails")}>
        <h3>{label("cpuDetails")}</h3>
        <Reading
          rows={[
            [label("model"), d?.cpuModel],
            [label("speed"), mhz(d?.cpuMhz)],
            [label("baseSpeed"), mhz(d?.baseMhz)],
            [label("maxSpeed"), mhz(d?.maxMhz)],
            [label("sockets"), count(d?.sockets)],
            [label("cores"), count(d?.cores)],
            [label("logical"), count(stats?.cpuCount)],
            [label("cache"), d?.cache],
            [label("processes"), count(d?.processes)],
            [label("threads"), count(d?.threads)],
            [label("handles"), count(d?.fileHandles)],
            [label("handleLimit"), count(d?.fileHandleLimit)],
            [t("panel.uptime"), stats ? formatUptime(stats.uptime) : "—"],
          ]}
        />
        {d?.logicalCpus.length ? (
          <details className="performance-cores" open={d.logicalCpus.length <= 32}>
            <summary>
              {label("logicalUsage")} · {d.logicalCpus.length}
            </summary>
            <div>
              {d.logicalCpus.map((core) => (
                <div key={core.name} className="performance-core">
                  <span>{core.name}</span>
                  <strong>{percent(core.percent)}</strong>
                  <div className="td-meter" aria-hidden="true">
                    <div
                      className="td-meter__fill"
                      style={{
                        width: `${finite(core.percent) ? Math.min(100, core.percent!) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
      <section className="performance-section" aria-label={label("memoryDetails")}>
        <h3>{label("memoryDetails")}</h3>
        <Reading
          rows={[
            [label("used"), bytes(stats?.memoryUsed)],
            [label("total"), bytes(stats?.memoryTotal)],
            [label("available"), bytes(d?.memoryAvailable)],
            [label("cached"), bytes(d?.memoryCached)],
            [label("buffers"), bytes(d?.memoryBuffers)],
            [label("slab"), bytes(d?.memorySlab)],
            [label("committed"), bytes(d?.memoryCommitted)],
            [label("commitLimit"), bytes(d?.memoryCommitLimit)],
            [label("pageTables"), bytes(d?.pageTables)],
            [label("kernelStack"), bytes(d?.kernelStack)],
            [label("swapUsed"), bytes(stats?.swapUsed)],
            [label("swapTotal"), bytes(stats?.swapTotal)],
          ]}
        />
      </section>
      <section className="performance-section" aria-label={label("diskDetails")}>
        <h3>{label("diskDetails")}</h3>
        <Reading
          rows={[
            [label("rootUsed"), bytes(stats?.diskUsed)],
            [label("rootCapacity"), bytes(stats?.diskTotal)],
          ]}
        />
        {d?.disks.length ? (
          d.disks.map((disk) => (
            <div className="performance-device" key={disk.name}>
              <h4>
                {disk.name} · {disk.model || "—"}
              </h4>
              <Reading
                rows={[
                  [label("capacity"), bytes(disk.capacity)],
                  [
                    label("type"),
                    disk.rotational == null
                      ? "—"
                      : label(disk.rotational ? "rotational" : "solidState"),
                  ],
                  [label("active"), percent(disk.activePercent)],
                  [
                    label("response"),
                    finite(disk.responseMs) ? `${disk.responseMs!.toFixed(2)} ms` : "—",
                  ],
                  [label("read"), rate(disk.readRate)],
                  [label("write"), rate(disk.writeRate)],
                ]}
              />
            </div>
          ))
        ) : (
          <p>{t("monitor.unavailable")}</p>
        )}
      </section>
      <section className="performance-section" aria-label={label("networkDetails")}>
        <h3>{label("networkDetails")}</h3>
        {d?.networks.length ? (
          d.networks.map((net) => (
            <div className="performance-device" key={net.name}>
              <h4>
                {net.name} · {net.state || "—"}
              </h4>
              <Reading
                rows={[
                  [label("receive"), rate(net.rxRate)],
                  [label("send"), rate(net.txRate)],
                  [label("linkSpeed"), finite(net.speedMbps) ? `${net.speedMbps} Mbps` : "—"],
                  [label("mac"), net.mac || "—"],
                  [label("addresses"), net.addresses.join(" · ") || "—"],
                ]}
              />
            </div>
          ))
        ) : (
          <p>{t("monitor.unavailable")}</p>
        )}
      </section>
      <section className="performance-section" aria-label={label("gpuDetails")}>
        <h3>{label("gpuDetails")}</h3>
        {d?.gpus.length ? (
          d.gpus.map((gpu, index) => (
            <div className="performance-device" key={index}>
              <h4>{gpu.name}</h4>
              <Reading
                rows={[
                  [label("utilization"), percent(gpu.percent)],
                  [label("gpuUsed"), bytes(gpu.memoryUsed)],
                  [label("gpuTotal"), bytes(gpu.memoryTotal)],
                  [label("temperature"), finite(gpu.temperature) ? `${gpu.temperature} °C` : "—"],
                  [label("driver"), gpu.driver || "—"],
                ]}
              />
            </div>
          ))
        ) : (
          <p>{t("monitor.unavailable")}</p>
        )}
      </section>
      <p className="performance-note">{label("linuxHint")}</p>
    </div>
  );
}
