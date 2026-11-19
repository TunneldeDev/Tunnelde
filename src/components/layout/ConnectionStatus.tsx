import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Disclosure } from "@/components/ui/layout/Disclosure";
import { ConnectionSession } from "./ConnectionSession";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { useSsh } from "@/store/ssh";
import "./connectionStatus.css";

export function ConnectionStatus() {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const history = useSsh((state) => state.history);
  const recent = history.filter(
    (entry) =>
      entry.endedAt !== null && !sessions.some((session) => session.id === entry.session.id),
  );
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
              <ConnectionSession
                key={session.id}
                session={session}
                history={history.find((entry) => entry.session.id === session.id)}
              />
            ))}
          </ul>
        )}
        <p className="connection-list__summary">{t("connections.historyHint")}</p>
        {!!recent.length && (
          <Disclosure heading={t("connections.recent")} summary={String(recent.length)}>
            <ul className="connection-list">
              {recent.map((entry) => (
                <ConnectionSession
                  key={entry.session.id}
                  session={entry.session}
                  history={entry}
                  ended
                />
              ))}
            </ul>
          </Disclosure>
        )}
      </Dialog>
    </>
  );
}
