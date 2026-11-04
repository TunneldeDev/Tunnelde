import { ArrowDownUp, CheckCheck, Pin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { cn } from "@/lib/text/format";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useTransfers, type TransferItem } from "@/store/transfers";
import { useTransferPanel } from "@/store/transferPanel";
import { TransferTask } from "./TransferTask";
import "./transferTasks.css";

export function TransferStatusButton({ floating = false }: { floating?: boolean }) {
  const { t } = useTranslation();
  const open = useTransferPanel((s) => s.open);
  const count = useTransfers((s) => s.items.filter((item) => item.status === "running").length);
  const attention = useTransfers(
    (s) => s.items.filter((item) => ["failed", "cleanupPending"].includes(item.status)).length,
  );
  return (
    <button
      type="button"
      className={cn(
        "transfer-status",
        floating && "is-floating",
        attention > 0 && "needs-attention",
      )}
      aria-label={t("sftp.backgroundTasks")}
      aria-expanded={open}
      aria-controls="background-transfers"
      data-transfer-trigger
      onClick={() => useTransferPanel.getState().toggle()}
    >
      <ArrowDownUp size={13} />
      <span>{count ? t("sftp.activeTransfers", { count }) : t("sftp.transfers")}</span>
      {attention > 0 ? <span className="transfer-status__badge">{attention}</span> : null}
    </button>
  );
}

function TaskGroup({
  name,
  items,
  now,
  onResume,
  defaultOpen = true,
}: {
  name: string;
  items: TransferItem[];
  now: number;
  onResume: (item: TransferItem) => void;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultOpen);
  const [limit, setLimit] = useState(20);
  if (!items.length) return null;
  return (
    <section className="transfer-group">
      <button
        className="transfer-group__heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
        <span>{name}</span>
        <span className="transfer-group__count">{items.length}</span>
      </button>
      {expanded ? (
        <>
          {items.slice(0, limit).map((item) => (
            <TransferTask key={item.id} item={item} now={now} onResume={() => onResume(item)} />
          ))}
          {items.length > limit ? (
            <Button
              size="sm"
              variant="ghost"
              className="transfer-group__more"
              onClick={() => setLimit(limit + 20)}
            >
              {t("sftp.moreTransfers", { count: items.length - limit })}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function FileTransfers() {
  const open = useTransferPanel((s) => s.open);
  return open ? <TransferPanelContent /> : null;
}

function TransferPanelContent() {
  const { t } = useTranslation();
  const items = useTransfers((s) => s.items);
  const pinned = useTransferPanel((s) => s.pinned);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [previousFocus] = useState(() => document.activeElement as HTMLElement | null);
  const [now, setNow] = useState(Date.now);
  const [connecting, setConnecting] = useState<{ hostId: string; taskId: string } | null>(null);
  const hosts = useHosts((s) => s.hosts);
  const running = items.some((item) => item.status === "running");
  const close = () => useTransferPanel.getState().close();
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [previousFocus]);
  useEffect(() => {
    if (pinned || connecting) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !panel.current?.contains(target) &&
        !target.closest("[data-transfer-trigger], [role='dialog'], .context-menu")
      )
        useTransferPanel.getState().close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pinned, connecting]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const resume = (item: TransferItem) => {
    const sessions = useSsh.getState().sessions;
    const endpoints = [
      ...(item.status === "cleanupPending"
        ? []
        : [{ id: item.fromHostId, address: item.fromAddress }]),
      { id: item.toHostId, address: item.toAddress },
    ];
    const missing = endpoints.find(
      ({ id, address }) =>
        id && !sessions.some((s) => s.hostId === id && (!address || s.address === address)),
    );
    if (missing?.id && hosts.some((h) => h.id === missing.id))
      setConnecting({ hostId: missing.id, taskId: item.id });
    else if (item.status === "cleanupPending") useTransfers.getState().clear(item.id);
    else useTransfers.getState().resume(item.id);
  };
  const active = items.filter((item) => ["running", "paused"].includes(item.status));
  const attention = items.filter((item) => ["failed", "cleanupPending"].includes(item.status));
  const finished = items.filter((item) => ["done", "cancelled"].includes(item.status));
  const host = connecting ? hosts.find((h) => h.id === connecting.hostId) : null;
  return (
    <>
      <aside
        className="transfer-panel"
        id="background-transfers"
        role="dialog"
        aria-modal="false"
        aria-label={t("sftp.backgroundTasks")}
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <header className="transfer-panel__header">
          <ArrowDownUp size={15} />
          <strong>{t("sftp.backgroundTasks")}</strong>
          <IconButton
            size="sm"
            active={pinned}
            label={t("sftp.keepTasksOpen")}
            onClick={() => useTransferPanel.getState().togglePinned()}
          >
            <Pin size={13} />
          </IconButton>
          <IconButton ref={closeButton} size="sm" label={t("common.close")} onClick={close}>
            <X size={14} />
          </IconButton>
        </header>
        <div className="transfer-panel__body">
          {!items.length ? (
            <p className="transfer-panel__empty">{t("sftp.noTransfers")}</p>
          ) : (
            <>
              <TaskGroup name={t("sftp.tasksActive")} items={active} now={now} onResume={resume} />
              <TaskGroup
                name={t("sftp.tasksAttention")}
                items={attention}
                now={now}
                onResume={resume}
              />
              <TaskGroup
                name={t("sftp.tasksFinished")}
                items={finished}
                now={now}
                onResume={resume}
                defaultOpen={false}
              />
            </>
          )}
        </div>
        {finished.length ? (
          <footer className="transfer-panel__footer">
            <Button
              size="sm"
              variant="ghost"
              leading={<CheckCheck size={13} />}
              onClick={() => {
                for (const item of finished) useTransfers.getState().clear(item.id);
              }}
            >
              {t("sftp.clearFinished")}
            </Button>
          </footer>
        ) : null}
      </aside>
      {host && connecting ? (
        <ConnectDialog
          key={host.id}
          host={host}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            const item = useTransfers.getState().items.find((i) => i.id === connecting.taskId);
            setConnecting(null);
            if (item?.status === "cleanupPending") void useTransfers.getState().hydrate();
            else if (item) queueMicrotask(() => resume(item));
          }}
        />
      ) : null}
    </>
  );
}
