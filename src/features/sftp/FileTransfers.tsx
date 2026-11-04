import { Gauge, Pause, Play, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { durationParts, transferProgress } from "@/lib/files/transferProgress";
import { cn, formatBytes } from "@/lib/text/format";
import { translateError } from "@/lib/api/errors";
import { useTransfers } from "@/store/transfers";
import { TransferSpeedLimit } from "./TransferSpeedLimit";

export function FileTransfers() {
  const { t } = useTranslation();
  const items = useTransfers((state) => state.items);
  const [now, setNow] = useState(Date.now);
  const [limitId, setLimitId] = useState<string | null>(null);
  const running = items.some((item) => item.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!items.length) return null;
  const actions = useTransfers.getState();
  const elapsed = (seconds: number) => {
    const parts = durationParts(seconds);
    return parts.hours
      ? t("sftp.durationHours", parts)
      : parts.minutes
        ? t("sftp.durationMinutes", parts)
        : t("sftp.durationSeconds", parts);
  };
  return (
    <footer className="sftp-transfers" aria-label={t("sftp.transfers")}>
      {items.map((item) => {
        const progress = transferProgress(item, Math.max(now, item.updatedAt));
        const state = item.clearing
          ? t("sftp.cleaningTransfer")
          : item.status === "running"
            ? item.pausing
              ? t("sftp.pausingTransfer")
              : item.cancelling
                ? t("sftp.cancelling")
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
        return (
          <div key={item.id} className={cn("transfer", `is-${item.status}`)}>
            <span className="transfer__name" title={item.name}>
              {item.name}
            </span>
            <span className="transfer__state">{state}</span>
            <span className="transfer__actions">
              {item.status === "running" ? (
                <IconButton
                  label={t("sftp.taskSpeedLimit")}
                  size="sm"
                  active={limitId === item.id || Boolean(item.speedLimitKib)}
                  aria-expanded={limitId === item.id}
                  disabled={item.cancelling || item.pausing}
                  onClick={() => setLimitId(limitId === item.id ? null : item.id)}
                >
                  <Gauge size={12} />
                </IconButton>
              ) : null}
              {item.durable && item.status === "running" ? (
                <IconButton
                  label={t("sftp.pauseTransfer")}
                  size="sm"
                  disabled={item.cancelling || item.pausing}
                  onClick={() => actions.pause(item.id)}
                >
                  <Pause size={12} />
                </IconButton>
              ) : null}
              {item.durable && ["paused", "failed", "cancelled"].includes(item.status) ? (
                <IconButton
                  label={t("sftp.resumeTransfer")}
                  size="sm"
                  disabled={item.clearing}
                  onClick={() => actions.resume(item.id)}
                >
                  <Play size={12} />
                </IconButton>
              ) : null}
              {item.durable && item.status !== "running" ? (
                <IconButton
                  label={t("sftp.clearTransfer")}
                  size="sm"
                  disabled={item.clearing}
                  onClick={() => actions.clear(item.id)}
                >
                  <Trash2 size={12} />
                </IconButton>
              ) : null}
              {item.status === "running" ? (
                <IconButton
                  label={t("sftp.cancelTransfer")}
                  size="sm"
                  disabled={item.cancelling || item.pausing}
                  onClick={() => actions.cancel(item.id)}
                >
                  <X size={12} />
                </IconButton>
              ) : null}
            </span>
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
            <span className="transfer__details">
              <span>
                {t("sftp.transferredBytes", { value: formatBytes(progress.transferred) })}
                {progress.total !== null ? ` / ${formatBytes(progress.total)}` : ""}
              </span>
              {progress.remaining !== null ? (
                <span>{t("sftp.remainingBytes", { value: formatBytes(progress.remaining) })}</span>
              ) : null}
              {item.status === "running" ? (
                <>
                  <span>
                    {progress.speed === null
                      ? t("sftp.calculatingSpeed")
                      : t("sftp.transferSpeed", { value: formatBytes(progress.speed) })}
                  </span>
                  {progress.eta !== null && progress.remaining !== 0 ? (
                    <span>{t("sftp.remainingTime", { value: elapsed(progress.eta) })}</span>
                  ) : null}
                  {item.speedLimitKib ? (
                    <span>{t("sftp.taskSpeedLimitValue", { value: item.speedLimitKib })}</span>
                  ) : null}
                </>
              ) : null}
            </span>
            {item.status === "running" && limitId === item.id ? (
              <TransferSpeedLimit
                key={item.id}
                id={item.id}
                value={item.speedLimitKib ?? 0}
                onClose={() => setLimitId(null)}
              />
            ) : null}
            {item.error ? (
              <span className="transfer__error">
                {translateError({ code: "ssh", message: item.error })}
              </span>
            ) : null}
          </div>
        );
      })}
    </footer>
  );
}
