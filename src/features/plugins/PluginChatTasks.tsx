import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleAlert, CircleDashed, History, LoaderCircle, Square } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import type { ChatTask } from "@/lib/plugins/pluginChat";

type Recover = (task: ChatTask, action: "inspect" | "resume") => void;

function Task({
  task,
  disabled,
  onRecover,
}: {
  task: ChatTask;
  disabled: boolean;
  onRecover?: Recover;
}) {
  const { t } = useTranslation();
  const StatusIcon =
    task.status === "running"
      ? LoaderCircle
      : task.status === "done"
        ? Check
        : task.status === "cancelled"
          ? Square
          : task.status === "queued"
            ? CircleDashed
            : CircleAlert;
  return (
    <article className="plugin-chat__task" data-status={task.status}>
      <div className="plugin-chat__task-head">
        <StatusIcon className="plugin-chat__task-icon" size={13} aria-hidden="true" />
        <strong>{task.title || task.id}</strong>
        <span>{t(`pluginChat.taskStates.${task.status}`)}</span>
      </div>
      {task.inspection ? (
        <details open>
          <summary>{t("pluginChat.taskDetails")}</summary>
          <pre tabIndex={0}>{task.inspection}</pre>
        </details>
      ) : null}
      {task.output && task.output !== task.inspection ? (
        <details>
          <summary>{t("pluginChat.taskOutput")}</summary>
          <pre tabIndex={0}>{task.output}</pre>
        </details>
      ) : null}
      {task.recoverable && onRecover ? (
        <div className="plugin-chat__actions">
          <span className="settings-hint">{t("pluginChat.recoveryHint")}</span>
          <Button size="sm" disabled={disabled} onClick={() => onRecover(task, "inspect")}>
            {t("pluginChat.inspectTask")}
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => onRecover(task, "resume")}>
            {t("pluginChat.resumeTask")}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** Keep live work and actionable failures visible without expanding every past CLI turn. */
export function PluginChatTasks({
  tasks,
  currentRunId,
  disabled,
  onRecover,
}: {
  tasks: ChatTask[];
  currentRunId?: string;
  disabled: boolean;
  onRecover?: Recover;
}) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const current: ChatTask[] = [];
  const history: ChatTask[] = [];
  for (const task of tasks) {
    const needsAttention =
      task.recoverable ||
      task.status === "queued" ||
      task.status === "running" ||
      (["failed", "interrupted"].includes(task.status) &&
        (!task.runId || task.runId === currentRunId));
    (needsAttention ? current : history).push(task);
  }
  if (!tasks.length) return null;
  const failures = history.filter((task) => ["failed", "interrupted"].includes(task.status)).length;
  return (
    <section className="plugin-chat__tasks" aria-label={t("pluginChat.tasks")}>
      {current.map((task) => (
        <Task key={task.id} task={task} disabled={disabled} onRecover={onRecover} />
      ))}
      {history.length ? (
        <details
          className="plugin-chat__task-history"
          open={historyOpen}
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary>
            <History size={13} aria-hidden="true" />
            <span>{t("pluginChat.taskHistory", { count: history.length })}</span>
            {failures ? (
              <small>{t("pluginChat.taskHistoryFailures", { count: failures })}</small>
            ) : null}
          </summary>
          {historyOpen ? (
            <div className="plugin-chat__task-history-body">
              {history.map((task) => (
                <Task key={task.id} task={task} disabled={disabled} onRecover={onRecover} />
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
