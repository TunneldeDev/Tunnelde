import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Network, Server } from "lucide-react";
import type { ConnectionPromptHost } from "@/features/connect/prompt";
import { PanelHeader } from "@/components/layout/WorkbenchPanel";
import { EmptyState } from "@/components/ui/display/Misc";
import { usePanelViewState } from "@/lib/panels/viewState";
import { forwardingSelection } from "../model/viewState";
import type { ForwardInfo } from "../model/contract";
import type { ForwardingReadData } from "../data/readModel";
import "../forwarding-panel.css";

export interface ForwardingPanelViewProps<H extends Pick<ConnectionPromptHost, "id" | "name">> {
  hosts: readonly H[];
  hostsLoading: boolean;
  sessions: ForwardingReadData["sessions"];
  rules: readonly ForwardInfo[];
  /** Already rendered by the owner; never interpret an error as authority. */
  error: string | null;
  target?: { hostId: string; revision: number } | null;
  renderHost(host: H): ReactNode;
  emptyAction?: ReactNode;
}
/** Shared panel presentation accepts only display models and explicit renderers.
 * Main and satellite owners supply different services; no host/navigation/dialog
 * stores, provider activation or native transport are acquired by this view.
 */
export function ForwardingPanelView<H extends Pick<ConnectionPromptHost, "id" | "name">>({
  hosts,
  hostsLoading,
  sessions,
  rules,
  error,
  target,
  renderHost,
  emptyAction,
}: ForwardingPanelViewProps<H>) {
  const { t } = useTranslation();
  const [selection, setSelection] = usePanelViewState<{
    hostId: string | null;
    targetRevision: number;
  }>("forwarding-selection", { hostId: null, targetRevision: 0 }, forwardingSelection);
  const selected =
    target && target.revision !== selection.targetRevision ? target.hostId : selection.hostId;
  useEffect(() => {
    // Consume external navigation into the explicit draft too. A destination
    // must not need the originating document's navigation store to reopen it.
    if (target && target.revision !== selection.targetRevision)
      setSelection({ hostId: target.hostId, targetRevision: target.revision });
  }, [target, selection.targetRevision, setSelection]);
  return (
    <div className="forwarding-panel">
      <PanelHeader view="forwarding" />
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
              {selected === host.id && renderHost(host)}
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
              action={emptyAction}
            />
          ))}
      </div>
    </div>
  );
}
