import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { isTauri } from "@/lib/api/ipc";
import { beforeWindowReload } from "@/lib/session/reload";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import {
  forwardStartPending,
  forwardStartRelease,
  forwardStartCancel,
  forwardStartConnection,
  type PendingForwardStart,
} from "./api";

/** Native events prompt an immediate refresh; polling also claims/renews the
 * document's lease, so a missed event cannot strand an external request. */
export function ForwardStartGate() {
  const { t } = useTranslation();
  const [uiId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState<PendingForwardStart | null>(null);
  const dismissed = useRef<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let polling = false;
    const refresh = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const next = await forwardStartPending(uiId);
        if (active)
          setPending((previous) =>
            next?.receipt.requestId === dismissed.current
              ? null
              : previous?.receipt.requestId === next?.receipt.requestId
                ? previous
                : next,
          );
      } catch (error) {
        if (active) console.warn("Cannot refresh forwarding startup request", error);
      } finally {
        polling = false;
      }
    };
    const listening = listen("forwarding://start-changed", () => {
      void refresh();
    });
    void listening
      .then(() => refresh())
      .catch((error) => {
        console.warn("Cannot subscribe to forwarding startup; polling remains active", error);
      });
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      active = false;
      window.clearInterval(timer);
      await listening.then((unlisten) => unlisten()).catch(() => undefined);
    };
    const removeReload = beforeWindowReload(async () => {
      await stop();
      await forwardStartRelease(uiId);
    });
    return () => {
      removeReload();
      void stop();
      // Native window destruction also cancels. A raw document navigation is
      // fenced by the next document claim or the native 15-second watchdog.
    };
  }, [uiId]);
  const connection = useMemo(
    () => (pending ? forwardStartConnection(pending, uiId) : null),
    [pending, uiId],
  );
  if (!pending || !connection) return null;
  return (
    <ConnectDialog
      key={pending.receipt.requestId}
      host={pending.host}
      after="background"
      purpose="forwarding"
      context={
        <div className="connect__hint">
          <strong>{pending.rule.name}</strong>
          <p>{t("forward.externalStartHint")}</p>
          <p>
            {t(pending.rule.mode === "local" ? "forward.local" : "forward.remote")} ·{" "}
            {pending.rule.bindHost}:{pending.rule.bindPort} → {pending.rule.targetHost}:
            {pending.rule.targetPort}
          </p>
        </div>
      }
      verification={connection.verification}
      connectSession={connection.connect}
      onConnected={() => undefined}
      onClose={() => {
        const id = pending.receipt.requestId;
        dismissed.current = id;
        void forwardStartCancel(id).catch((error) => toast(translateError(error), "error"));
        setPending(null);
      }}
    />
  );
}
