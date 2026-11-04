import { ChevronDown, Gauge, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { durationParts, transferProgress } from "@/lib/files/transferProgress";
import { cn, formatBytes } from "@/lib/text/format";
import { translateError } from "@/lib/api/errors";
import { useTransfers, type TransferItem } from "@/store/transfers";
import { TransferSpeedLimit } from "./TransferSpeedLimit";

export function TransferTask({
  item,
  now,
  onResume,
}: {
  item: TransferItem;
  now: number;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const progress = transferProgress(item, Math.max(now, item.updatedAt));
  const actions = useTransfers.getState();
  const busy = item.clearing || item.cancelling || item.pausing;
  const pending = item.status === "cleanupPending";
  const running = item.status === "running";
  const waiting = item.phase === "queued" || item.phase === "preparing";
  const state = item.clearing
    ? t("sftp.cleaningTransfer")
    : pending
      ? t("sftp.cleanupPending")
      : running
        ? item.pausing
          ? t("sftp.pausingTransfer")
          : item.cancelling
            ? t("sftp.cancelling")
            : item.phase === "queued"
              ? t("sftp.queuedTransfer")
              : item.phase === "preparing"
                ? t("sftp.preparingTransfer")
                : item.phase === "cleaning"
                  ? t("sftp.cleaningTransfer")
                  : item.phase === "verifying"
                    ? t("sftp.verifyingTransfer")
                    : progress.percent === null
                      ? t("sftp.preparingTransfer")
                      : `${Math.floor(progress.percent)}%`
        : t(
            item.status === "done"
              ? "sftp.done"
              : item.status === "paused"
                ? "sftp.paused"
                : item.status === "cancelled"
                  ? "sftp.cancelled"
                  : "sftp.failed",
          );
  const elapsed = (seconds: number) => {
    const parts = durationParts(seconds);
    return t(
      parts.hours
        ? "sftp.durationHours"
        : parts.minutes
          ? "sftp.durationMinutes"
          : "sftp.durationSeconds",
      parts,
    );
  };
  return (
    <article className={cn("transfer-task", `is-${item.status}`)} aria-label={item.name}>
      <div className="transfer-task__row">
        <button
          type="button"
          className="transfer-task__toggle"
          title={item.name}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={12} className={expanded ? "is-expanded" : undefined} />
          <span>{item.name}</span>
        </button>
        <span className="transfer-task__state">{state}</span>
        <span className="transfer__actions">
          {running ? (
            <>
              <IconButton
                label={t("sftp.taskSpeedLimit")}
                size="sm"
                active={limitOpen || Boolean(item.speedLimitKib)}
                aria-expanded={limitOpen}
                disabled={busy}
                onClick={() => {
                  setExpanded(true);
                  setLimitOpen(!limitOpen);
                }}
              >
                <Gauge size={13} />
              </IconButton>
              {item.durable ? (
                <IconButton
                  label={t("sftp.pauseTransfer")}
                  size="sm"
                  disabled={busy}
                  onClick={() => actions.pause(item.id)}
                >
                  <Pause size={13} />
                </IconButton>
              ) : null}
              <IconButton
                label={t("sftp.cancelTransfer")}
                size="sm"
                disabled={busy}
                onClick={() => actions.cancel(item.id)}
              >
                <X size={13} />
              </IconButton>
            </>
          ) : (
            <>
              {item.durable && ["paused", "failed"].includes(item.status) ? (
                <IconButton
                  label={t("sftp.resumeTransfer")}
                  size="sm"
                  disabled={busy}
                  onClick={onResume}
                >
                  <Play size={13} />
                </IconButton>
              ) : null}
              <IconButton
                label={t(pending ? "sftp.retryCleanup" : "sftp.clearTransfer")}
                size="sm"
                disabled={busy}
                onClick={() => (pending ? onResume() : actions.clear(item.id))}
              >
                {pending ? <RefreshCw size={13} /> : <Trash2 size={13} />}
              </IconButton>
            </>
          )}
        </span>
      </div>
      <span
        className={cn("transfer__meter", progress.percent === null && "is-indeterminate")}
        role="progressbar"
        aria-label={item.name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent === null ? undefined : Math.floor(progress.percent)}
        aria-valuetext={state}
      >
        <span style={{ width: progress.percent === null ? "25%" : `${progress.percent}%` }} />
      </span>
      <div className="transfer-task__summary">
        <span>
          {formatBytes(progress.transferred)}
          {progress.total !== null ? ` / ${formatBytes(progress.total)}` : ""}
        </span>
        {running && !waiting ? (
          <span>
            {progress.speed === null
              ? t("sftp.calculatingSpeed")
              : t("sftp.transferSpeed", { value: formatBytes(progress.speed) })}
          </span>
        ) : null}
        {running && !waiting && progress.eta !== null && progress.remaining !== 0 ? (
          <span>{t("sftp.remainingTime", { value: elapsed(progress.eta) })}</span>
        ) : null}
      </div>
      {pending ? <p className="transfer-task__notice">{t("sftp.cleanupPendingHint")}</p> : null}
      {item.error && !pending ? (
        <p className="transfer-task__error">
          {translateError({ code: "ssh", message: item.error })}
        </p>
      ) : null}
      {expanded ? (
        <div className="transfer-task__details">
          {item.fromPath ? (
            <p>
              <span>{t("sftp.transferFrom")}</span>
              <code>
                {item.fromAddress ? `${item.fromAddress}:` : ""}
                {item.fromPath}
              </code>
            </p>
          ) : null}
          {item.toPath ? (
            <p>
              <span>{t("sftp.transferTo")}</span>
              <code>
                {item.toAddress ? `${item.toAddress}:` : ""}
                {item.toPath}
              </code>
            </p>
          ) : null}
          {progress.remaining !== null ? (
            <p>{t("sftp.remainingBytes", { value: formatBytes(progress.remaining) })}</p>
          ) : null}
          {item.speedLimitKib ? (
            <p>{t("sftp.taskSpeedLimitValue", { value: item.speedLimitKib })}</p>
          ) : null}
          {pending && item.error ? (
            <p className="transfer-task__error">
              {translateError({ code: "ssh", message: item.error })}
            </p>
          ) : null}
          {running && limitOpen ? (
            <TransferSpeedLimit
              id={item.id}
              value={item.speedLimitKib ?? 0}
              onClose={() => setLimitOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
