import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, RefreshCw, Trash2, X, ExternalLink } from "lucide-react";
import { IconButton } from "@/components/ui/form/Button";
import { translateError } from "@/lib/api/errors";
import { formatBytes } from "@/lib/text/format";
import type { TaskViewProps } from "./presentation";

const ICONS = { cancel: X, pause: Pause, resume: Play, retry: RefreshCw, clear: Trash2 };

export function BackgroundTaskRow({ task }: TaskViewProps) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = task.progress;
  const completed = Number.isFinite(progress?.completed) ? Math.max(0, progress!.completed) : 0;
  const total =
    progress?.unit === "percent"
      ? 100
      : progress?.total && Number.isFinite(progress.total)
        ? Math.max(0, progress.total)
        : null;
  const percent =
    task.status === "done" ? 100 : total ? Math.min(100, (completed / total) * 100) : null;
  const format = (value: number) =>
    progress?.unit === "bytes"
      ? formatBytes(value)
      : new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
  return (
    <article className={`background-task is-${task.status}`} aria-label={task.title}>
      <div className="background-task__row">
        <strong title={task.title}>{task.title}</strong>
        <span className="background-task__state">{t(`tasks.status.${task.status}`)}</span>
        <span className="background-task__actions">
          {task.actions?.map((action) => {
            const Icon = ICONS[action.id as keyof typeof ICONS] ?? ExternalLink;
            return (
              <IconButton
                key={action.id}
                size="sm"
                label={
                  action.label ||
                  (Object.hasOwn(ICONS, action.id)
                    ? t(`tasks.action.${action.id as keyof typeof ICONS}`)
                    : t("common.open"))
                }
                disabled={busy || action.disabled}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void Promise.resolve()
                    .then(action.run)
                    .catch((error) => setError(translateError(error)))
                    .finally(() => setBusy(false));
                }}
              >
                <Icon size={13} />
              </IconButton>
            );
          })}
        </span>
      </div>
      {progress || task.status === "running" ? (
        <span
          className={`background-task__meter${percent === null ? " is-indeterminate" : ""}`}
          role="progressbar"
          aria-label={task.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <span style={{ width: percent === null ? undefined : `${percent}%` }} />
        </span>
      ) : null}
      {task.message ? <p className="background-task__message">{task.message}</p> : null}
      {progress ? (
        <span className="background-task__summary">
          {format(completed)}
          {total ? ` / ${format(total)}` : ""}
        </span>
      ) : null}
      {error || task.error ? (
        <p role="status" className="background-task__error">
          {error ?? task.error}
        </p>
      ) : null}
    </article>
  );
}
