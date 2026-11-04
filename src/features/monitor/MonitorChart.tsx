import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatPercent } from "@/lib/text/format";
import type { MonitorSample } from "@/store/monitorHistory";

type MetricKey = "cpu" | "memory" | "rx" | "tx" | "diskRead" | "diskWrite";
type ChartKind = "cpu" | "memory" | "network" | "disk";
const TICKS = [1, 0.75, 0.5, 0.25, 0];
const TONES: Record<ChartKind, string[]> = {
  cpu: ["accent"],
  memory: ["green"],
  network: ["accent", "orange"],
  disk: ["green", "orange"],
};

// Geometry changes with samples, not panel width or tooltip selection. Keep the
// SVG subtree independent so resizing only needs the browser's vector scaling.
const ChartLines = memo(function ChartLines({
  paths,
  kind,
}: {
  paths: string[][][];
  kind: ChartKind;
}) {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {TICKS.map((tick) => (
        <line
          key={tick}
          x1="0"
          x2="100"
          y1={96 - tick * 92}
          y2={96 - tick * 92}
          className="monitor-chart__grid"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {paths.map((segments, lineIndex) => (
        <g key={lineIndex} className={`monitor-chart__series is-${TONES[kind][lineIndex]}`}>
          {segments.map((points, segment) =>
            points.length === 1 ? (
              <circle
                key={segment}
                cx={points[0]!.split(",")[0]}
                cy={points[0]!.split(",")[1]}
                r="1"
              />
            ) : (
              <polyline key={segment} points={points.join(" ")} vectorEffect="non-scaling-stroke" />
            ),
          )}
        </g>
      ))}
    </svg>
  );
});

/** A shared, timestamp-based view of the bounded session history. */
export const MonitorChart = memo(function MonitorChart({
  samples,
  kind,
  label,
}: {
  samples: MonitorSample[];
  kind: ChartKind;
  label: string;
}) {
  const { t, i18n } = useTranslation();
  const [selectedAt, setSelectedAt] = useState<number | null>(null);
  const percent = kind === "cpu" || kind === "memory";
  const series: { key: MetricKey; label: string; tone: string }[] =
    kind === "network"
      ? [
          { key: "rx", label: t("monitor.receive"), tone: "accent" },
          { key: "tx", label: t("monitor.send"), tone: "orange" },
        ]
      : kind === "disk"
        ? [
            { key: "diskRead", label: t("monitor.read"), tone: "green" },
            { key: "diskWrite", label: t("monitor.write"), tone: "orange" },
          ]
        : [{ key: kind, label, tone: kind === "cpu" ? "accent" : "green" }];
  const keys = series.map((item) => item.key).join(",");
  const { ceiling, paths } = useMemo(() => {
    const metricKeys = keys.split(",") as MetricKey[];
    let peak = 0;
    for (const sample of samples) {
      for (const key of metricKeys) peak = Math.max(peak, sample[key] ?? 0);
    }
    const ceiling = percent ? 100 : Math.max(1024, 2 ** Math.ceil(Math.log2(peak || 1)));
    const firstAt = samples[0]?.at ?? 0;
    const duration = (samples.at(-1)?.at ?? firstAt) - firstAt;
    const paths = metricKeys.map((key) => {
      const segments: string[][] = [];
      let segment: string[] | null = null;
      for (const sample of samples) {
        const value = sample[key];
        if (value === null || !Number.isFinite(value)) {
          segment = null;
          continue;
        }
        if (!segment) {
          segment = [];
          segments.push(segment);
        }
        const x = duration > 0 ? ((sample.at - firstAt) / duration) * 100 : 100;
        const y = 96 - (Math.min(ceiling, Math.max(0, value)) / ceiling) * 92;
        segment.push(`${x.toFixed(3)},${y.toFixed(3)}`);
      }
      return segments;
    });
    return { ceiling, paths };
  }, [samples, keys, percent]);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [i18n.resolvedLanguage],
  );
  const preciseNumber = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }),
    [i18n.resolvedLanguage],
  );
  const format = (value: number | null, precise = false) =>
    value === null
      ? t("monitor.unavailable")
      : percent
        ? precise
          ? `${preciseNumber.format(value)}%`
          : formatPercent(value)
        : `${formatBytes(value, precise ? 2 : 1)}/s`;
  const last = samples.at(-1);
  let index = samples.length - 1;
  if (selectedAt !== null) {
    while (index > 0 && samples[index]!.at > selectedAt) index--;
  }
  const selected = samples[index];
  const firstAt = samples[0]?.at ?? 0;
  const duration = (last?.at ?? firstAt) - firstAt;
  const cursor = selected && duration > 0 ? ((selected.at - firstAt) / duration) * 100 : 100;
  const description = selected
    ? `${formatter.format(selected.at)} · ${series.map((item) => `${item.label} ${format(selected[item.key], true)}`).join(" · ")}`
    : t("panel.waiting");

  return (
    <div className="monitor-chart">
      <div className="monitor-chart__axis" aria-hidden="true">
        {TICKS.map((tick) => (
          <span key={tick} style={{ top: `${4 + (1 - tick) * 92}%` }}>
            {format(tick * ceiling)}
          </span>
        ))}
      </div>
      <div
        className="monitor-chart__plot"
        role="slider"
        tabIndex={samples.length ? 0 : -1}
        aria-label={t("monitor.chart", { metric: label })}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, samples.length - 1)}
        aria-valuenow={Math.max(0, index)}
        aria-valuetext={description}
        onMouseMove={(event) => {
          if (!samples.length) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          const at =
            firstAt + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
          let closest = samples[0]!;
          for (const sample of samples)
            if (Math.abs(sample.at - at) < Math.abs(closest.at - at)) closest = sample;
          setSelectedAt(closest.at);
        }}
        onMouseLeave={() => setSelectedAt(null)}
        onFocus={() => last && setSelectedAt(last.at)}
        onBlur={() => setSelectedAt(null)}
        onKeyDown={(event) => {
          if (!samples.length) return;
          let next = index;
          if (event.key === "ArrowLeft") next--;
          else if (event.key === "ArrowRight") next++;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = samples.length - 1;
          else return;
          event.preventDefault();
          setSelectedAt(samples[Math.min(samples.length - 1, Math.max(0, next))]!.at);
        }}
      >
        <ChartLines paths={paths} kind={kind} />
        {selectedAt !== null && selected ? (
          <div
            className="monitor-chart__cursor"
            style={{ left: `${cursor}%` }}
            aria-hidden="true"
          />
        ) : null}
        {!samples.length ? <p className="monitor-chart__empty">{t("panel.waiting")}</p> : null}
        {kind === "disk" &&
        samples.length > 0 &&
        !samples.some((sample) => sample.diskRead !== null) ? (
          <p className="monitor-chart__empty">{t("monitor.unavailable")}</p>
        ) : null}
        {selectedAt !== null && selected ? (
          <div
            className="monitor-chart__tooltip"
            role="tooltip"
            style={{ left: `${Math.min(100, Math.max(0, cursor))}%` }}
            data-side={cursor > 50 ? "left" : "right"}
          >
            <time dateTime={new Date(selected.at).toISOString()}>
              {formatter.format(selected.at)}
            </time>
            {series.map((item) => (
              <span key={item.key}>
                <i className={`is-${item.tone}`} />
                {item.label}
                <strong>{format(selected[item.key], true)}</strong>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="monitor-chart__times" aria-hidden="true">
        {samples.length ? (
          <>
            <time>{formatter.format(firstAt)}</time>
            {duration > 0 ? <time>{formatter.format(last!.at)}</time> : null}
          </>
        ) : (
          <span>—</span>
        )}
      </div>
      {series.length > 1 ? (
        <div className="monitor-chart__legend">
          {series.map((item) => (
            <span key={item.key}>
              <i className={`is-${item.tone}`} />
              {item.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});
