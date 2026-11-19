import { PanelViewStateGroup } from "@/lib/panels/viewState";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { panelPresentation } from "@/store/panelPresentation";
import { togglePanel } from "@/lib/panels/controller";
import { PanelHeader } from "./WorkbenchPanel";
import { useConnectionPanelModel } from "@/lib/panels/connectionModel";
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
  const { sessions, history, hosts } = useConnectionPanelModel();
  const recent = history.filter(
    (entry) =>
      entry.endedAt !== null && !sessions.some((session) => session.id === entry.session.id),
  );
  const groups = [...new Set(sessions.map((session) => session.hostId))];
  return (
    <PanelViewStateGroup name="connections.rows">
      <div className="connection-panel">
        <PanelHeader view="connections" />
        <div className="connection-panel__body" data-panel-scroll="connections.body">
          <div className="connection-panel__overview" role="status">
            <strong>{t("status.connections", { count: sessions.length })}</strong>
            <span>{t("connections.sessions", { count: sessions.length })}</span>
          </div>
          {!sessions.length ? (
            <p className="connection-list__empty">{t("connections.empty")}</p>
          ) : (
            groups.map((hostId) => {
              const own = sessions.filter((session) => session.hostId === hostId);
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
