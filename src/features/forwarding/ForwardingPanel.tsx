import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Network, Plus, Server } from "lucide-react";
import { ForwardingSection } from "./ForwardingSection";
import { useForwardingSnapshot } from "./forwardingStore";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { translateError } from "@/lib/api/errors";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import { sidebarTabId } from "@/lib/session/sidebarDock";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { EmptyState } from "@/components/ui/display/Misc";
import { Button } from "@/components/ui/form/Button";
import "./forwarding-panel.css";

export function ForwardingPanel() {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const hostsLoading = useHosts((state) => state.loading && !state.loaded);
  const openHost = useDialogs((state) => state.openHost);
  const sessions = useSsh((state) => state.sessions);
  const target = useNavigation((state) => state.forwardingTarget);
  const docked = useWorkspace((state) =>
    state.tabs.some((tab) => tab.id === sidebarTabId("forwarding")),
  );
  const [selection, setSelection] = useState<{
    hostId: string | null;
    targetRevision: number;
  }>({ hostId: null, targetRevision: 0 });
  const selected =
    target && target.revision !== selection.targetRevision ? target.hostId : selection.hostId;
  const snapshot = useForwardingSnapshot();
  const rules = snapshot.entries ?? [];
  const error = snapshot.error ? translateError(snapshot.error) : "";
  return (
    <div className="forwarding-panel">
      {!docked && (
        <header className="sidebar__head">
          <SidebarTitle view="forwarding">{t("forward.title")}</SidebarTitle>
          <SidebarDockControls view="forwarding" />
        </header>
      )}
      <div className="forwarding-panel__content">
        {error && (
          <p className="forwarding-panel__error" role="alert">
            {error}
          </p>
        )}
        {hosts.map((host) => {
          const own = rules.filter((rule) => rule.hostId === host.id);
          const active = own.filter(
            (rule) => rule.active && sessions.some((s) => s.id === rule.sessionId),
          ).length;
          return (
            <div key={host.id} className="forwarding-panel__host">
              <button
                type="button"
                className="forwarding-panel__host-button"
                aria-expanded={selected === host.id}
                onClick={() => {
                  setSelection({
                    hostId: selected === host.id ? null : host.id,
                    targetRevision: target?.revision ?? 0,
                  });
                }}
              >
                <ChevronRight className="forwarding-panel__chevron" size={14} aria-hidden="true" />
                <Server size={14} aria-hidden="true" />
                <span>{host.name}</span>
                {active > 0 && (
                  <small className="is-running">
                    {active} {t("forward.running")}
                  </small>
                )}
              </button>
              {selected === host.id && <ForwardingSection key={host.id} host={host} embedded />}
            </div>
          );
        })}
        {!hosts.length &&
          (hostsLoading ? (
            <p className="forwarding-panel__loading" role="status">
              {t("common.loading")}
            </p>
          ) : (
            <EmptyState
              icon={<Network size={22} aria-hidden="true" />}
              title={t("sidebar.empty")}
              body={t("forward.noHostsHint")}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  leading={<Plus size={13} />}
                  onClick={() => openHost()}
                >
                  {t("sidebar.newHost")}
                </Button>
              }
            />
          ))}
      </div>
    </div>
  );
}
