import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { useSsh } from "@/store/ssh";
import "./connectionStatus.css";

export function ConnectionStatus() {
  const { t, i18n } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="statusbar__sep" />
      <button
        type="button"
        className="statusbar__link"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {t("status.connections", { count: sessions.length })}
      </button>
      <Dialog
        open={open}
        title={t("connections.title")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        width={560}
      >
        <p className="connection-list__summary" role="status">
          {t("connections.sessions", { count: sessions.length })}
        </p>
        {!sessions.length ? (
          <p className="connection-list__empty">{t("connections.empty")}</p>
        ) : (
          <ul className="connection-list">
            {sessions.map((session) => (
              <li key={session.id} className="connection-list__item">
                <div className="connection-list__heading">
                  <strong>{session.title}</strong>
                  <span>
                    {t(
                      session.purpose === "forwarding"
                        ? "connections.forwarding"
                        : session.purpose === "mounts"
                          ? "connections.mounts"
                          : session.terminal === false
                            ? "connections.background"
                            : "connections.terminal",
                    )}
                  </span>
                </div>
                <dl>
                  <dt>{t("connections.address")}</dt>
                  <dd>
                    <code>{session.address}</code>
                  </dd>
                  <dt>{t("connections.connectedAt")}</dt>
                  <dd>{new Date(session.connectedAt).toLocaleString(i18n.language)}</dd>
                  <dt>{t("connections.sessionId")}</dt>
                  <dd>
                    <code>{session.id}</code>
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
