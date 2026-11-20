import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { ConnectionDisclosure } from "./ConnectionDisclosure";
import { usePanelViewState } from "@/lib/panels/viewState";
import type { SshSession } from "@/lib/api/types";
import { useConnectionPanelModel } from "@/lib/panels/connectionModel";
import type { SessionHistory } from "@/store/sshHistory";

export function ConnectionSession({
  session,
  history,
  ended = false,
  grouped = false,
  selection,
}: {
  session: SshSession;
  history?: SessionHistory;
  ended?: boolean;
  grouped?: boolean;
  selection?: { checked: boolean; disabled: boolean; onChange: () => void };
}) {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = usePanelViewState(
    `session:${session.id}:confirm`,
    false,
    (value): value is boolean => typeof value === "boolean",
  );
  const model = useConnectionPanelModel();
  const pending = model.disconnectingSessionIds.includes(session.id);
  const purpose = t(
    session.purpose === "forwarding"
      ? "connections.forwarding"
      : session.purpose === "mounts"
        ? "connections.mounts"
        : session.terminal === false
          ? "connections.background"
          : "connections.terminal",
  );
  const events = history?.events ?? [{ kind: "connected", at: session.connectedAt }];
  const date = (at: number) => new Date(at).toLocaleString(i18n.language);
  return (
    <li className="connection-list__item" aria-label={`${session.title} · ${session.id}`}>
      <div className="connection-list__heading">
        {selection && !ended && (
          <input
            type="checkbox"
            className="td-checkbox connection-list__select"
            aria-label={t("connections.selectSession", { name: session.title, id: session.id })}
            checked={selection.checked}
            disabled={selection.disabled || pending}
            onChange={selection.onChange}
          />
        )}
        <div className="connection-list__identity">
          <strong>{grouped ? purpose : session.title}</strong>
          <code>{session.address}</code>
        </div>
        {!ended && (
          <Button
            size="sm"
            variant="ghost-danger"
            disabled={pending || confirming}
            onClick={() => setConfirming(true)}
          >
            {t(pending ? "connections.disconnecting" : "connections.disconnect")}
          </Button>
        )}
      </div>
      {confirming && !ended && (
        <div
          className="connection-list__confirm"
          role="group"
          aria-label={t("connections.disconnect")}
        >
          <p>{t("connections.disconnectWarning")}</p>
          <div className="connection-list__actions">
            <Button size="sm" disabled={pending} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={async () => {
                await model.disconnect(session.id);
                setConfirming(false);
              }}
            >
              {t(pending ? "connections.disconnecting" : "connections.confirmDisconnect")}
            </Button>
          </div>
        </div>
      )}
      <ConnectionDisclosure
        stateKey={`session:${session.id}:details`}
        heading={t("connections.details")}
        summary={`${grouped ? "" : `${purpose} · `}${t(ended ? "connections.ended" : pending ? "connections.disconnecting" : "connections.connected")}`}
      >
        <dl>
          <dt>{t("connections.address")}</dt>
          <dd>
            <code>{session.address}</code>
          </dd>
          <dt>{t("connections.connectedAt")}</dt>
          <dd>{date(session.connectedAt)}</dd>
          <dt>{t("connections.sessionId")}</dt>
          <dd>
            <code>{session.id}</code>
          </dd>
          <dt>{t("connections.hostId")}</dt>
          <dd>
            <code>{session.hostId}</code>
          </dd>
          {session.terminal !== false && (
            <>
              <dt>{t("connections.terminalSize")}</dt>
              <dd>
                {session.cols} × {session.rows}
              </dd>
            </>
          )}
        </dl>
        <div className="connection-list__history">
          <h4>{t("connections.history")}</h4>
          <ol>
            {events.map((event, index) => (
              <li key={index}>
                <time dateTime={new Date(event.at).toISOString()}>{date(event.at)}</time>
                <span>{t(`connections.events.${event.kind}`)}</span>
                {event.detail && <code>{event.detail}</code>}
              </li>
            ))}
          </ol>
        </div>
      </ConnectionDisclosure>
    </li>
  );
}
