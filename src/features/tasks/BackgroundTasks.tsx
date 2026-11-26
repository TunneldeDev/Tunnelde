import { useTaskPanelModel } from "@/lib/panels/taskModel";
import { PanelViewStateGroup, usePanelViewState } from "@/lib/panels/viewState";
import { ListTodo, CheckCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { PanelHeader, useWorkbenchPanel } from "@/components/layout/WorkbenchPanel";
import { togglePanelAt } from "@/lib/panels/controller";
import { cn } from "@/lib/text/format";
import {
  useBackgroundTasks,
  isFinishedTask,
  canClearBackgroundTask,
  type BackgroundTaskEntry,
} from "@/lib/tasks/background";
import { useBackgroundTaskPanel } from "@/store/backgroundTaskPanel";
import { taskPresentation } from "./presentation";
import { BackgroundTaskRow } from "./BackgroundTaskRow";
import { toast } from "@/store/toasts";
import { presentError } from "@/lib/api/errors";
import { BackgroundTasksSurface } from "./components/BackgroundTasksSurface";
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
        "statusbar__link statusbar__panel-button background-status",
        floating && "is-floating",
        running.length > 0 && "is-running",
        paused.length > 0 && !running.length && "is-paused",
        attention > 0 && "needs-attention",
      )}
      aria-label={t("tasks.title")}
      aria-description={hint}
      title={hint}
      aria-expanded={open}
      aria-controls="sidebar-tasks"
      data-panel-trigger="tasks"
      data-task-trigger
      onClick={() => togglePanelAt("tasks", "floating")}
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
  stateKey,
  items,
  now,
  defaultOpen = true,
}: {
  name: string;
  stateKey: string;
  items: BackgroundTaskEntry[];
  now: number;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const model = useTaskPanelModel();
  const [expanded, setExpanded] = usePanelViewState(
    stateKey + ":expanded",
    defaultOpen,
    (v): v is boolean => typeof v === "boolean",
  );
  const [limit, setLimit] = usePanelViewState(
    stateKey + ":limit",
    20,
    (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 20 && v <= 100_000,
  );
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
            return <View key={model.viewKey(task)} task={task} now={now} />;
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

/** Compatibility export; presentation is now the shared floating layer. */
export { FloatingPanelLayer as BackgroundTasks } from "@/components/layout/SidebarDock";

export function DockedBackgroundTasks() {
  const { t } = useTranslation();
  const model = useTaskPanelModel();
  const allItems = model.items;
  const items = allItems.filter((item) => item.visible !== false);
  const scope = useWorkbenchPanel();
  const visible = scope?.visible ?? true;
  const embedded = scope?.location !== "floating";
  const [now, setNow] = useState(Date.now);
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  const running = items.some((item) => item.status === "running");
  useEffect(() => {
    if (!running || !visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, visible]);
  const active = items.filter((item) => ["running", "paused"].includes(item.status));
  const attention = items.filter((item) => item.status === "attention");
  const finished = items.filter(isFinishedTask);
  const clearable = items.filter(canClearBackgroundTask).length;
  const clearFinished = async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    try {
      const errors = await model.clear();
      if (errors.count)
        toast(t("tasks.clearFailed", { count: errors.count, error: errors.first ?? "" }), "error");
    } catch (error) {
      toast(presentError(error), "error");
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  };
  return (
    <PanelViewStateGroup name="tasks.rows">
      <div className="background-panel is-embedded">
        <PanelHeader view="tasks" />
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
        <BackgroundTasksSurface entries={allItems} embedded={embedded} visible={visible}>
          <div className="background-panel__body" data-panel-scroll="tasks.body">
            {!items.length ? (
              <p className="background-panel__empty">{t("tasks.empty")}</p>
            ) : (
              <>
                <TaskGroup
                  stateKey="tasks.active"
                  name={t("tasks.inProgress")}
                  items={active}
                  now={now}
                />
                <TaskGroup
                  stateKey="tasks.attention"
                  name={t("tasks.attention")}
                  items={attention}
                  now={now}
                />
                <TaskGroup
                  stateKey="tasks.finished"
                  name={t("tasks.finished")}
                  items={finished}
                  now={now}
                  defaultOpen={false}
                />
              </>
            )}
          </div>
        </BackgroundTasksSurface>
      </div>
    </PanelViewStateGroup>
  );
}
