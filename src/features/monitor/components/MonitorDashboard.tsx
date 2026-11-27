import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
  type CSSProperties,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Maximize2,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { habitStorage, HABITS_CHANGED } from "@/lib/habits/storage";
import { usePointerDrag } from "@/lib/session/usePointerDrag";
import { useBackgroundGuard } from "@/lib/session/viewState";
import type { RemoteStats } from "@/lib/api/types";
import type { MonitorSample } from "@/store/monitorHistory";
import {
  defaultDashboardLayout,
  moveWidget,
  readDashboardLayout,
  resizeWidget,
  type MonitorWidget,
  type WidgetLayout,
} from "../dashboardLayout";
import { MonitorMetric } from "./MonitorCharts";
import { PerformanceDetails } from "./PerformanceDetails";
import "../dashboard.css";

function subscribe(listener: () => void) {
  window.addEventListener(HABITS_CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(HABITS_CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}

/** One layout per host across sessions and presentations; never owns sampling. */
export function MonitorDashboard({
  hostId,
  stats,
  samples,
}: {
  hostId: string;
  stats: RemoteStats | null;
  samples: MonitorSample[];
}) {
  const { t } = useTranslation();
  const storageKey = `tunnelde.panels.monitor-dashboard.${encodeURIComponent(hostId)}.layout`;
  const raw = useSyncExternalStore(subscribe, () => habitStorage.getItem(storageKey));
  const widgets = useMemo(() => readDashboardLayout(raw), [raw]);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<MonitorWidget | null>(null);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const orderDrag = useRef<MonitorWidget | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const save = (next: WidgetLayout[]) => {
    try {
      habitStorage.setItem(storageKey, JSON.stringify({ version: 1, widgets: next }));
      setSaveError(false);
      return true;
    } catch {
      setSaveError(true);
      return false;
    }
  };
  const title = (id: MonitorWidget) =>
    id === "gpu" ? t("performance.gpuDetails") : t(`panel.${id}`);
  const move = (id: MonitorWidget, target: MonitorWidget) => {
    if (save(moveWidget(widgets, id, target))) {
      setNotice(t("monitorLayout.moved", { name: title(id) }));
    }
  };
  return (
    <div className="monitor-dashboard" data-editing={editing || undefined}>
      <div className="monitor-dashboard__toolbar">
        <span>{t(editing ? "monitorLayout.editHint" : "monitorLayout.autoHint")}</span>
        {editing && (
          <Button
            size="sm"
            variant="ghost"
            leading={<RotateCcw size={13} />}
            onClick={() => save(defaultDashboardLayout())}
          >
            {t("monitorLayout.reset")}
          </Button>
        )}
        <Button
          size="sm"
          variant={editing ? "secondary" : "ghost"}
          leading={editing ? <Check size={13} /> : <SlidersHorizontal size={13} />}
          onClick={() => setEditing(!editing)}
          aria-pressed={editing}
        >
          {t(editing ? "monitorLayout.done" : "monitorLayout.edit")}
        </Button>
      </div>
      {saveError && (
        <p role="alert" className="panel__error">
          {t("monitorLayout.saveError")}
        </p>
      )}
      <span className="sr-only" role="status">
        {notice}
      </span>
      <div
        ref={grid}
        className="monitor-dashboard__grid"
        data-wide={width >= 640 || undefined}
        style={
          {
            "--widget-min-columns":
              width >= 640 ? Math.min(12, Math.ceil(280 / ((width + 12) / 12))) : 12,
          } as CSSProperties
        }
      >
        {widgets.map((widget, index) => (
          <DashboardWidget
            key={widget.id}
            widget={widget}
            title={title(widget.id)}
            editing={editing}
            width={width}
            dragging={dragging === widget.id}
            earlier={index > 0 ? () => move(widget.id, widgets[index - 1]!.id) : undefined}
            later={
              index < widgets.length - 1 ? () => move(widget.id, widgets[index + 1]!.id) : undefined
            }
            update={(next) => save(widgets.map((item) => (item.id === next.id ? next : item)))}
            startOrder={() => {
              orderDrag.current = widget.id;
              setDragging(widget.id);
            }}
            endOrder={() => {
              orderDrag.current = null;
              setDragging(null);
            }}
            dropOrder={() => {
              const source = orderDrag.current;
              if (source) move(source, widget.id);
              orderDrag.current = null;
              setDragging(null);
            }}
          >
            {widget.id !== "gpu" && <MonitorMetric kind={widget.id} samples={samples} />}
            <PerformanceDetails kind={widget.id} stats={stats} />
          </DashboardWidget>
        ))}
      </div>
      <p className="performance-note">{t("performance.linuxHint")}</p>
    </div>
  );
}

function DashboardWidget({
  widget,
  title,
  editing,
  width,
  dragging,
  earlier,
  later,
  update,
  startOrder,
  endOrder,
  dropOrder,
  children,
}: {
  widget: WidgetLayout;
  title: string;
  editing: boolean;
  width: number;
  dragging: boolean;
  earlier?: () => void;
  later?: () => void;
  update: (next: WidgetLayout) => boolean;
  startOrder: () => void;
  endOrder: () => void;
  dropOrder: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  useBackgroundGuard(dragging);
  const [over, setOver] = useState(false);
  const columns = width >= 640 ? 12 : 1;
  return (
    <article
      ref={ref}
      className="monitor-widget"
      aria-label={title}
      data-widget={widget.id}
      data-dragging={dragging || undefined}
      data-drop-target={over || undefined}
      style={
        {
          "--widget-columns": widget.columns,
          "--widget-height": widget.height === null ? undefined : `${widget.height}px`,
          "--widget-chart-height":
            widget.height === null
              ? undefined
              : `${Math.max(100, Math.min(260, widget.height * 0.32))}px`,
        } as CSSProperties
      }
      onDragOver={(event) => {
        if (!editing || !event.dataTransfer.types.includes("application/x-tunnelde-monitor-widget"))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        if (!editing || !event.dataTransfer.types.includes("application/x-tunnelde-monitor-widget"))
          return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        dropOrder();
      }}
    >
      <header className="monitor-widget__head">
        {editing && (
          <IconButton
            size="sm"
            className="monitor-widget__grip"
            label={t("monitorLayout.reorder", { name: title })}
            draggable
            onDragStart={(event) => {
              if (event.target !== event.currentTarget) return;
              event.stopPropagation();
              event.dataTransfer.setData("application/x-tunnelde-monitor-widget", widget.id);
              event.dataTransfer.effectAllowed = "move";
              startOrder();
            }}
            onDragEnd={endOrder}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" && earlier) {
                event.preventDefault();
                earlier();
              }
              if (event.key === "ArrowDown" && later) {
                event.preventDefault();
                later();
              }
            }}
          >
            <GripVertical size={13} />
          </IconButton>
        )}
        <h2>{title}</h2>
        {editing && (
          <div className="monitor-widget__actions">
            <IconButton
              size="sm"
              label={t("monitorLayout.earlier", { name: title })}
              disabled={!earlier}
              onClick={earlier}
            >
              <ArrowUp size={12} />
            </IconButton>
            <IconButton
              size="sm"
              label={t("monitorLayout.later", { name: title })}
              disabled={!later}
              onClick={later}
            >
              <ArrowDown size={12} />
            </IconButton>
            <IconButton
              size="sm"
              label={t(widget.columns === 12 ? "monitorLayout.half" : "monitorLayout.full", {
                name: title,
              })}
              disabled={columns === 1}
              onClick={() => update({ ...widget, columns: widget.columns === 12 ? 6 : 12 })}
            >
              <Maximize2 size={12} />
            </IconButton>
            <IconButton
              size="sm"
              label={t("monitorLayout.resetWidget", { name: title })}
              onClick={() => update({ ...widget, columns: 6, height: null })}
            >
              <RotateCcw size={12} />
            </IconButton>
          </div>
        )}
      </header>
      <div className="monitor-widget__body">{children}</div>
      {editing && (
        <WidgetResizeHandle
          key={width}
          panel={ref}
          widget={widget}
          title={title}
          width={width}
          update={update}
        />
      )}
    </article>
  );
}

function WidgetResizeHandle({
  panel: ref,
  widget,
  title,
  width,
  update,
}: {
  panel: RefObject<HTMLElement | null>;
  widget: WidgetLayout;
  title: string;
  width: number;
  update: (next: WidgetLayout) => boolean;
}) {
  const { t } = useTranslation();
  const pointerDrag = usePointerDrag();
  const [resizing, setResizing] = useState(false);
  useBackgroundGuard(resizing);
  const columns = width >= 640 ? 12 : 1;
  return (
    <button
      type="button"
      className="monitor-widget__resize"
      aria-label={t("monitorLayout.resize", { name: title })}
      title={t("monitorLayout.resize", { name: title })}
      onPointerDown={(event) => {
        if (event.button !== 0 || !ref.current) return;
        const element = ref.current;
        const start = element.getBoundingClientRect();
        const x = event.clientX,
          y = event.clientY;
        let latest = widget;
        const previous = element.getAttribute("style");
        const rollback = () => {
          if (previous === null) element.removeAttribute("style");
          else element.setAttribute("style", previous);
        };
        setResizing(true);
        pointerDrag(event, {
          move: (next) => {
            latest = resizeWidget(
              widget,
              start.width,
              start.height,
              next.clientX - x,
              next.clientY - y,
              width,
              columns,
            );
            element.style.setProperty("--widget-columns", String(latest.columns));
            element.style.setProperty("--widget-height", `${latest.height}px`);
            element.style.setProperty(
              "--widget-chart-height",
              `${Math.max(100, Math.min(260, latest.height! * 0.32))}px`,
            );
          },
          commit: () => {
            setResizing(false);
            if (!update(latest)) rollback();
          },
          cancel: () => {
            rollback();
            setResizing(false);
          },
        });
      }}
      onKeyDown={(event) => {
        if (
          !event.key.startsWith("Arrow") ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          !ref.current
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const rect = ref.current.getBoundingClientRect();
        const unit = (width + 12) / 12;
        update(
          resizeWidget(
            widget,
            rect.width,
            rect.height,
            event.key === "ArrowLeft" ? -unit : event.key === "ArrowRight" ? unit : 0,
            event.key === "ArrowUp" ? -40 : event.key === "ArrowDown" ? 40 : 0,
            width,
            columns,
          ),
        );
      }}
    />
  );
}
