import { useRef, useState } from "react";
import { SearchToolbar } from "@/components/ui/layout/SearchToolbar";
import { Button } from "@/components/ui/form/Button";
import { parseSearchQuery } from "@/lib/search/query";
import {
  CONNECTION_FILTER_KEYS,
  connectionType,
  connectionStatus,
  matchesConnection,
} from "@/lib/session/connectionSearch";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { panelPresentation } from "@/store/panelPresentation";
import { togglePanel } from "@/lib/panels/controller";
import { PanelHeader } from "./WorkbenchPanel";
import { useConnectionPanelModel } from "@/lib/panels/connectionModel";
import { usePanelViewState, PanelViewStateGroup } from "@/lib/panels/viewState";
import { useTranslation } from "react-i18next";
import { ConnectionDisclosure } from "./ConnectionDisclosure";
import { ConnectionSession } from "./ConnectionSession";
import { useSsh } from "@/store/ssh";
import "./connectionStatus.css";

export function ConnectionStatus() {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const open = panelPresentation("connections")((state) => state.open);
  const dockedVisible = useWorkspace(
    (state) =>
      state.tabs.some((tab) => tab.id === "sidebar:connections" && !tab.hidden) &&
      state.panes.some((pane) => pane.activeId === "sidebar:connections"),
  );
  const sidebarVisible = useNavigation(
    (state) => state.sidebarVisible && state.activeSidebar === "connections",
  );
  return (
    <>
      <span className="statusbar__sep" />
      <button
        type="button"
        className="statusbar__link"
        aria-expanded={open || dockedVisible || sidebarVisible}
        data-panel-trigger="connections"
        aria-controls="sidebar-connections"
        onClick={() => togglePanel("connections", "floating")}
      >
        {t("status.connections", { count: sessions.length })}
      </button>
    </>
  );
}

export function ConnectionDetails() {
  const { t } = useTranslation();
  const model = useConnectionPanelModel();
  const { sessions, history, hosts, disconnectingSessionIds: pending } = model;
  const [query, setQuery] = usePanelViewState(
    "connections.query",
    "",
    (v): v is string => typeof v === "string",
  );
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((id) => typeof id === "string");
  const [selection, setSelection] = usePanelViewState<string[]>(
    "connections.selection",
    [],
    strings,
  );
  const [confirming, setConfirming] = usePanelViewState<string[] | null>(
    "connections.confirming",
    null,
    (v): v is string[] | null => v === null || strings(v),
  );
  const [busy, setBusy] = useState(false);
  const batch = useRef(false);
  const search = parseSearchQuery(query, CONNECTION_FILTER_KEYS);
  const hostName = (session: (typeof sessions)[number]) =>
    hosts.find((host) => host.id === session.hostId)?.name ?? session.title;
  const matches = (session: (typeof sessions)[number], ended = false) => {
    const entry = history.find((item) => item.session.id === session.id);
    const status = connectionStatus(ended, pending.includes(session.id), entry);
    const type = connectionType(session);
    return matchesConnection(search, session, {
      host: hostName(session),
      status,
      labels: [
        t(`connections.${type}`),
        t(
          status === "failed"
            ? "connections.events.disconnectFailed"
            : status === "disconnecting"
              ? "connections.disconnecting"
              : `connections.${status}`,
        ),
      ],
    });
  };
  const visible = sessions.filter((session) => matches(session));
  const selectable = visible.filter((session) => !pending.includes(session.id));
  const selected = selectable.filter((session) => selection.includes(session.id));
  const changeQuery = (value: string) => {
    setQuery(value);
    setSelection([]);
    setConfirming(null);
  };
  const closeSelected = async () => {
    if (batch.current || !confirming) return;
    const ids = confirming.filter(
      (id) => sessions.some((session) => session.id === id) && !pending.includes(id),
    );
    batch.current = true;
    setBusy(true);
    try {
      const result = await model.disconnectMany(ids);
      setSelection(result.failed);
      setConfirming(null);
    } finally {
      batch.current = false;
      setBusy(false);
    }
  };
  const recent = history.filter(
    (entry) =>
      entry.endedAt !== null &&
      !sessions.some((session) => session.id === entry.session.id) &&
      matches(entry.session, true),
  );
  const groups = [...new Set(visible.map((session) => session.hostId))];
  return (
    <PanelViewStateGroup name="connections.rows">
      <div className="connection-panel">
        <PanelHeader view="connections" />
        <div className="connection-panel__body" data-panel-scroll="connections.body">
          <div className="connection-panel__overview" role="status">
            <strong>{t("status.connections", { count: sessions.length })}</strong>
            <span>{t("connections.sessions", { count: sessions.length })}</span>
          </div>
          <SearchToolbar
            value={query}
            onChange={changeQuery}
            disabled={busy}
            aria-label={t("connections.search")}
            placeholder={t("connections.search")}
            filterKeys={CONNECTION_FILTER_KEYS}
            presets={[
              ...(["terminal", "background", "forwarding", "mounts"] as const).map((type) => ({
                key: "type",
                value: type,
                label: t(`connections.${type}`),
              })),
              ...(["connected", "disconnecting", "failed", "ended"] as const).map(
                (status, index) => ({
                  key: "status",
                  value: status,
                  label: t(
                    status === "failed"
                      ? "connections.events.disconnectFailed"
                      : `connections.${status}`,
                  ),
                  separatorBefore: index === 0,
                }),
              ),
              { key: "host", value: "", label: t("connections.hostId"), separatorBefore: true },
            ]}
            status={t("connections.selected", { count: selected.length })}
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !selectable.length}
                  onClick={() =>
                    setSelection(
                      selected.length === selectable.length
                        ? []
                        : selectable.map((session) => session.id),
                    )
                  }
                >
                  {t(
                    selectable.length > 0 && selected.length === selectable.length
                      ? "connections.clearSelection"
                      : "connections.selectVisible",
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost-danger"
                  disabled={busy || !selected.length}
                  onClick={() => setConfirming(selected.map((session) => session.id))}
                >
                  {t("connections.closeSelected")}
                </Button>
              </>
            }
          />
          {confirming && (
            <div
              className="connection-list__confirm"
              role="group"
              aria-label={t("connections.closeSelected")}
            >
              <p>
                {t("connections.batchWarning", {
                  count: confirming.filter((id) => sessions.some((session) => session.id === id))
                    .length,
                })}
              </p>
              <div className="connection-list__actions">
                <Button size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={
                    busy ||
                    !confirming.some(
                      (id) =>
                        sessions.some((session) => session.id === id) && !pending.includes(id),
                    )
                  }
                  onClick={() => void closeSelected()}
                >
                  {t(busy ? "connections.disconnecting" : "connections.confirmDisconnect")}
                </Button>
              </div>
            </div>
          )}
          {!sessions.length ? (
            <p className="connection-list__empty">{t("connections.empty")}</p>
          ) : !visible.length ? (
            <p className="connection-list__empty">{t("connections.noMatches")}</p>
          ) : (
            groups.map((hostId) => {
              const own = visible.filter((session) => session.hostId === hostId);
              return (
                <section className="connection-host" key={hostId}>
                  <header className="connection-host__heading">
                    <h3>{hosts.find((host) => host.id === hostId)?.name ?? own[0]!.title}</h3>
                    <span>{own.length}</span>
                  </header>
                  <ul className="connection-list">
                    {own.map((session) => (
                      <ConnectionSession
                        key={session.id}
                        session={session}
                        grouped
                        selection={{
                          checked: selected.some((item) => item.id === session.id),
                          disabled: busy,
                          onChange: () => {
                            setConfirming(null);
                            setSelection((ids) =>
                              ids.includes(session.id)
                                ? ids.filter((id) => id !== session.id)
                                : [...ids, session.id],
                            );
                          },
                        }}
                        history={history.find((entry) => entry.session.id === session.id)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
          <p className="connection-list__summary">{t("connections.historyHint")}</p>
          {!!recent.length && (
            <ConnectionDisclosure
              stateKey="connections.recent"
              heading={t("connections.recent")}
              summary={String(recent.length)}
            >
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
            </ConnectionDisclosure>
          )}
        </div>
      </div>
    </PanelViewStateGroup>
  );
}
