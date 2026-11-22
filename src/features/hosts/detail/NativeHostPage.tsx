import { connectionPromptHost } from "@/features/connect/prompt";
import { useEffect } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { HostPage, HostPageView, type HostPageServices } from "../HostPage";
import { useHostDetailRegistrations } from "./registration";
import type { HostDetailModel } from "./model";
import type { HostDetailOperation } from "./protocol";
import { useNativeReadModel, type NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { useWindowViews } from "@/lib/panels/windowViews";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { NativeWorkspaceFrame } from "@/components/layout/NativeWorkspaceFrame";
import { useLocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { useWindowForwardingBinding } from "@/features/forwarding/components/WindowForwardingPanel";
import { WindowForwardingSection } from "@/features/forwarding/components/WindowForwardingSection";
import { ForwardingSurfaceBody } from "@/features/forwarding/components/ForwardingSurface";
import { ForwardingReadScope } from "@/features/forwarding/data/readScope";
import { Button } from "@/components/ui/form/Button";
import { isTauri } from "@/lib/api/ipc";
import { notifyError } from "@/lib/api/errors";
import { movePanelToWindow } from "@/lib/panels/windowMoves";
export const useNativeHostTitles = create<{ titles: Record<string, string> }>(() => ({
  titles: {},
}));
export function MainNativeHostPage({ tabId, hostId }: { tabId: string; hostId: string | null }) {
  const id = useHostDetailRegistrations((s) => s.entries.get(tabId));
  const record = useWindowViews((s) => s.entries.get(id ?? ""));
  if (!isTauri()) return <HostPage hostId={hostId} />;
  if (!id) return <div role="status" aria-busy="true" />;
  return (
    <NativePanelView panelId={id}>
      {record ? <HostPage hostId={hostId} /> : <div role="status" aria-busy="true" />}
    </NativePanelView>
  );
}
function Content({ client, record, model }: NativeViewProps & { model: HostDetailModel }) {
  const { t } = useTranslation();
  const { ready } = useWindowForwardingBinding(client, record);
  const detail = model.detail,
    host = detail.host;
  const run = (operation: HostDetailOperation) => {
    const current = useWindowViews.getState().entries.get(record.panelId);
    if (
      !detail.target ||
      !current?.lease ||
      current.staged ||
      current.moving ||
      current.key !== record.key ||
      current.controller !== record.controller ||
      current.failed
    )
      return;
    void client
      .action(current.lease, { kind: "hostDetail", command: { operation, host: detail.target } })
      .catch((error) => notifyError(error, { domain: "hosts.detail", operation }));
  };
  const services: HostPageServices = {
    connect: () => run("connect"),
    sftp: () => run("sftp"),
    favorite: () => run("favorite"),
    edit: () => run("edit"),
    remove: () => run("delete"),
    duplicate: () => run("duplicate"),
  };
  return (
    <>
      {!detail.allowMove && (
        <div className="native-panel-interruption" role="status">
          {t("plugin.frontend.viewUnavailable")}
          <Button
            onClick={() =>
              void movePanelToWindow(record.panelId, "main").catch((error) =>
                notifyError(error, { domain: "panels", operation: "returnToMain" }),
              )
            }
          >
            {t("panels.returnToMainWindow")}
          </Button>
        </div>
      )}
      <div className="provider-content" inert={!detail.allowMove}>
        <HostPageView
          host={host}
          groupName={detail.groupName}
          hostCount={detail.hostCount}
          services={services}
        >
          {host?.source ? (
            <section className="card">
              <p className="connect__hint">{t("hostSources.configureHint")}</p>
              <Button variant="secondary" size="sm" onClick={services.duplicate}>
                {t("hostSources.saveCopy")}
              </Button>
            </section>
          ) : (
            host && (
              <ForwardingReadScope value={detail.forwarding}>
                <WindowForwardingSection
                  key={host.id}
                  host={connectionPromptHost(host)}
                  client={client}
                  lease={ready?.lease}
                  service={ready?.service}
                  renderSurface={(surface) => (
                    <ForwardingSurfaceBody
                      {...surface}
                      renderProvider={(context) => <context.Entries />}
                    />
                  )}
                />
              </ForwardingReadScope>
            )
          )}
        </HostPageView>
      </div>
    </>
  );
}
export function NativeHostView(props: NativeViewProps) {
  const model = useNativeReadModel<HostDetailModel>(props),
    scope = useLocalPanelScope(),
    { t } = useTranslation();
  const title = model?.detail.host?.name ?? t("host.details");
  useEffect(() => {
    if (model)
      useNativeHostTitles.setState((s) =>
        s.titles[props.record.panelId] === title
          ? s
          : { titles: { ...s.titles, [props.record.panelId]: title } },
      );
  }, [model, props.record.panelId, title]);
  if (!model) return <div role="status" aria-busy="true" />;
  const content = <Content {...props} model={model} />;
  return (
    <NativePanelView panelId={props.record.panelId}>
      {scope ? (
        <NativeWorkspaceFrame scope={scope} title={title}>
          {content}
        </NativeWorkspaceFrame>
      ) : (
        content
      )}
    </NativePanelView>
  );
}
