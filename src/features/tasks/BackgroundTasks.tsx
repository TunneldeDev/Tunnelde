import { ListTodo, CheckCheck, Pin, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { useFloatingPanel } from "@/components/layout/useFloatingPanel";
import { cn } from "@/lib/text/format";
import {
  useBackgroundTasks,
  isFinishedTask,
  canClearBackgroundTask,
  clearFinishedBackgroundTasks,
  type BackgroundTaskEntry,
} from "@/lib/tasks/background";
import { useBackgroundTaskPanel } from "@/store/backgroundTaskPanel";
import { taskPresentation } from "./presentation";
import { BackgroundTaskRow } from "./BackgroundTaskRow";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import "./backgroundTasks.css";

export function BackgroundTaskStatusButton({ floating = false }: { floating?: boolean }) {
  const { t } = useTranslation();
  const open = useBackgroundTaskPanel((s) => s.open);
  const items = useBackgroundTasks((s) => s.items);
  const visible = items.filter((item) => item.visible !== false);
  const running = visible.filter((item) => item.status === "running");
  const paused = visible.filter((item) => item.status === "paused");
  const attention = visible.filter((item) => item.status === "attention").length;
  const fractions = running.map((item) => {
    const progress = item.progress;
    const total = progress?.unit === "percent" ? 100 : progress?.total;
    return progress &&
      Number.isFinite(progress.completed) &&
      total &&
      Number.isFinite(total) &&
      total > 0
      ? Math.max(0, Math.min(1, progress.completed / total))
      : null;
  });
  const percent =
    running.length && fractions.every((value) => value !== null)
      ? Math.floor(
          (fractions.reduce<number>((sum, value) => sum + (value ?? 0), 0) / running.length) * 100,
        )
      : null;
  const label = running.length
    ? t("tasks.active", { count: running.length })
    : paused.length
      ? t("tasks.pausedCount", { count: paused.length })
      : t("tasks.title");
  const progressLabel =
    percent !== null ? t("tasks.aggregateProgress", { percent }) : t("tasks.progressUnknown");
  const hint = [
    label,
    ...(running.length ? [progressLabel] : []),
    ...[...running, ...paused].slice(0, 3).map((item) => item.title),
    ...(attention ? [t("tasks.attentionCount", { count: attention })] : []),
  ].join("\n");
  return (
    <button
      type="button"
      className={cn(
        "background-status",
        floating && "is-floating",
        running.length > 0 && "is-running",
        paused.length > 0 && !running.length && "is-paused",
        attention > 0 && "needs-attention",
      )}
      aria-label={t("tasks.title")}
      aria-description={hint}
      title={hint}
      aria-expanded={open}
      aria-controls="background-tasks"
      data-task-trigger
      onClick={() => useBackgroundTaskPanel.getState().toggle()}
    >
      <ListTodo size={13} />
      <span aria-live="polite" aria-atomic="true">
        {label}
      </span>
      {percent !== null ? <span className="background-status__percent">{percent}%</span> : null}
      {running.length ? (
        <>
          <span
            key={running.map((item) => item.key).join("|")}
            className="background-status__pulse"
            aria-hidden="true"
          />
          <span
            className={cn("background-status__progress", percent === null && "is-indeterminate")}
            role="progressbar"
            aria-label={t("tasks.aggregateProgressLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={progressLabel}
          >
            <span style={{ width: percent === null ? undefined : `${percent}%` }} />
          </span>
        </>
      ) : null}
      {attention > 0 ? <span className="background-status__badge">{attention}</span> : null}
    </button>
  );
}

function TaskGroup({
  name,
  items,
  now,
  defaultOpen = true,
}: {
  name: string;
  items: BackgroundTaskEntry[];
  now: number;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultOpen);
  const [limit, setLimit] = useState(20);
  if (!items.length) return null;
  return (
    <section className="background-group">
      <button
        className="background-group__heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
        <span>{name}</span>
        <span className="background-group__count">{items.length}</span>
      </button>
      {expanded ? (
        <>
          {items.slice(0, limit).map((task) => {
            const View = taskPresentation(task.source) ?? BackgroundTaskRow;
            return <View key={task.key} task={task} now={now} />;
          })}
          {items.length > limit ? (
            <Button
              size="sm"
              variant="ghost"
              className="background-group__more"
              onClick={() => setLimit(limit + 20)}
            >
              {t("tasks.more", { count: items.length - limit })}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function BackgroundTasks() {
  const open = useBackgroundTaskPanel((s) => s.open);
  return open ? <BackgroundPanelContent /> : null;
}

function BackgroundPanelContent() {
  const { t } = useTranslation();
  const allItems = useBackgroundTasks((s) => s.items);
  const items = allItems.filter((item) => item.visible !== false);
  const pinned = useBackgroundTaskPanel((s) => s.pinned);
  const panel = useRef<HTMLElement>(null);
  const bounds = useBackgroundTaskPanel((s) => s.bounds);
  const floating = useFloatingPanel(panel, bounds, useBackgroundTaskPanel.getState().setBounds);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [previousFocus] = useState(() => document.activeElement as HTMLElement | null);
  const [now, setNow] = useState(Date.now);
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  const running = items.some((item) => item.status === "running");
  const close = () => useBackgroundTaskPanel.getState().close();
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [previousFocus]);
  useEffect(() => {
    if (pinned) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !panel.current?.contains(target) &&
        !target.closest("[data-task-trigger], [role='dialog'], .context-menu") &&
        !document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        useBackgroundTaskPanel.getState().close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pinned]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const active = items.filter((item) => ["running", "paused"].includes(item.status));
  const attention = items.filter((item) => item.status === "attention");
  const finished = items.filter(isFinishedTask);
  const clearable = items.filter(canClearBackgroundTask).length;
  const clearFinished = async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    try {
      const errors = await clearFinishedBackgroundTasks();
      if (errors.length)
        toast(
          t("tasks.clearFailed", { count: errors.length, error: translateError(errors[0]) }),
          "error",
        );
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  };
  return (
    <>
      <aside
        className="background-panel"
        id="background-tasks"
        role="dialog"
        aria-modal="false"
        aria-label={t("tasks.title")}
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <header className="background-panel__header">
          <button
            type="button"
            className="background-panel__drag"
            title={t("tasks.moveHint")}
            {...floating.handle("move")}
            onDoubleClick={floating.reset}
          >
            <ListTodo size={15} />
            <strong>{t("tasks.title")}</strong>
          </button>
          <IconButton size="sm" label={t("tasks.resetLayout")} onClick={floating.reset}>
            <RotateCcw size={13} />
          </IconButton>
          <IconButton
            size="sm"
            active={pinned}
            label={t("tasks.keepOpen")}
            onClick={() => useBackgroundTaskPanel.getState().togglePinned()}
          >
            <Pin size={13} />
          </IconButton>
          <IconButton ref={closeButton} size="sm" label={t("common.close")} onClick={close}>
            <X size={14} />
          </IconButton>
        </header>
        <div className="background-panel__toolbar">
          <Button
            size="sm"
            variant="ghost"
            leading={<CheckCheck size={13} />}
            disabled={clearing || !clearable}
            aria-label={t("tasks.clearFinished")}
            aria-busy={clearing}
            title={t("tasks.clearHint")}
            onClick={() => void clearFinished()}
          >
            {t(clearing ? "tasks.clearing" : "tasks.clearFinished")}
            {clearable > 0 ? (
              <span className="background-panel__clear-count" aria-hidden="true">
                {clearable}
              </span>
            ) : null}
          </Button>
        </div>
        <div className="background-panel__body">
          {!items.length ? (
            <p className="background-panel__empty">{t("tasks.empty")}</p>
          ) : (
            <>
              <TaskGroup name={t("tasks.inProgress")} items={active} now={now} />
              <TaskGroup name={t("tasks.attention")} items={attention} now={now} />
              <TaskGroup
                name={t("tasks.finished")}
                items={finished}
                now={now}
                defaultOpen={false}
              />
            </>
          )}
        </div>
        {(["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const).map((edge) => (
          <div
            key={edge}
            className={`background-panel__resize background-panel__resize--${edge}`}
            {...floating.handle(edge)}
            {...(edge === "se"
              ? { role: "button", tabIndex: 0, "aria-label": t("tasks.resizeHint") }
              : { "aria-hidden": true })}
          />
        ))}
      </aside>
    </>
  );
}
