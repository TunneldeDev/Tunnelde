/** Versioned view preferences only; sampling and native resource ownership are independent. */
export const MONITOR_WIDGETS = ["cpu", "memory", "network", "disk", "gpu"] as const;
export type MonitorWidget = (typeof MONITOR_WIDGETS)[number];
export interface WidgetLayout {
  id: MonitorWidget;
  columns: number;
  height: number | null;
}
export const defaultDashboardLayout = (): WidgetLayout[] =>
  MONITOR_WIDGETS.map((id) => ({ id, columns: 6, height: null }));

export function readDashboardLayout(raw: string | null): WidgetLayout[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("widgets" in value) ||
      !Array.isArray(value.widgets)
    )
      return defaultDashboardLayout();
    const seen = new Set<MonitorWidget>();
    const widgets: WidgetLayout[] = [];
    for (const item of value.widgets.slice(0, 32)) {
      if (!item || !MONITOR_WIDGETS.includes(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      widgets.push({
        id: item.id,
        columns: Number.isInteger(item.columns) ? Math.max(4, Math.min(12, item.columns)) : 6,
        height:
          typeof item.height === "number" && Number.isFinite(item.height)
            ? Math.max(280, Math.min(1200, item.height))
            : null,
      });
    }
    return [...widgets, ...defaultDashboardLayout().filter((item) => !seen.has(item.id))];
  } catch {
    return defaultDashboardLayout();
  }
}

export function moveWidget(widgets: WidgetLayout[], id: MonitorWidget, target: MonitorWidget) {
  const from = widgets.findIndex((item) => item.id === id);
  const to = widgets.findIndex((item) => item.id === target);
  if (from < 0 || to < 0 || from === to) return widgets;
  const next = [...widgets];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function resizeWidget(
  start: WidgetLayout,
  width: number,
  height: number,
  dx: number,
  dy: number,
  areaWidth: number,
  columns: number,
): WidgetLayout {
  const unit = (areaWidth + 12) / columns;
  const minColumns = Math.min(columns, Math.max(4, Math.ceil(280 / unit)));
  return {
    ...start,
    // Preserve the desktop width preference while a narrow panel forces one column.
    columns:
      columns === 1
        ? start.columns
        : Math.max(minColumns, Math.min(columns, Math.round((width + dx + 12) / unit))),
    height: Math.round(Math.max(280, Math.min(1200, height + dy))),
  };
}
