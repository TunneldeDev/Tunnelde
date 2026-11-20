import { PanelViewStateGroup, usePanelViewState } from "@/lib/panels/viewState";
import { groupEditor as validGroupEditor, type ForwardGroupEditor } from "./model/viewState";
import { ForwardGroupDialog } from "./components/ForwardGroupDialog";
import { HelpHint } from "@/components/ui/form/HelpHint";
import { Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { useDialogs } from "@/store/dialogs";
import type { Host } from "@/lib/api/types";
import { ForwardRuleEditor } from "./components/ForwardRuleEditor";
import { ForwardingSurface } from "./components/ForwardingSurface";
import { ForwardGroups } from "./components/ForwardGroups";
import { useForwardingController } from "./runtime/useForwardingController";
import "./forwarding.css";

export type { ForwardRule } from "./model/contract";
export { forwardingSavePayload } from "./model/payload";

export function ForwardingSection(props: { host: Host; embedded?: boolean }) {
  const { t } = useTranslation();
  const openHost = useDialogs((state) => state.openHost);
  if (props.host.source)
    return (
      <section className="card">
        <p className="connect__hint">{t("hostSources.configureHint")}</p>
        <Button variant="secondary" size="sm" onClick={() => openHost(props.host)}>
          {t("hostSources.saveCopy")}
        </Button>
      </section>
    );
  return (
    <PanelViewStateGroup key={props.host.id} name="forwarding-host">
      <SavedForwardingSection {...props} />
    </PanelViewStateGroup>
  );
}
function SavedForwardingSection({ host, embedded = false }: { host: Host; embedded?: boolean }) {
  const { t } = useTranslation();
  const controller = useForwardingController(host);
  const [groupEditor, setGroupEditor] = usePanelViewState<ForwardGroupEditor>(
    "group-editor",
    null,
    (value): value is ForwardGroupEditor => validGroupEditor(value, host.id),
  );
  const { rules, loading, session, canStart, form, busy, failure, connectingRules } = controller;
  return (
    <section className={`forwarding ${embedded ? "" : "card"}`} aria-busy={busy}>
      <header className="forwarding__head">
        <div>
          {!embedded && <h2 className="card__title">{t("forward.title")}</h2>}
          <p className="forwarding__subtitle">
            {host.username && `${host.username}@`}
            {host.host || host.name}
            {host.port ? `:${host.port}` : ""}
          </p>
        </div>
        {!form ? (
          <div className="forwarding__tools">
            <Button
              size="sm"
              leading={<Plus size={14} />}
              disabled={busy}
              onClick={() => controller.add()}
            >
              {t("forward.add")}
            </Button>
            <Button
              size="sm"
              leading={<Plus size={14} />}
              disabled={busy || loading}
              onClick={() => setGroupEditor({ hostId: host.id })}
            >
              {t("forward.addGroup")}
            </Button>
            <HelpHint label={t("forward.addGroup")}>{t("forward.groupHint")}</HelpHint>
            <IconButton
              label={t("forward.refresh")}
              disabled={busy || loading}
              onClick={controller.refresh}
            >
              <RefreshCw size={14} />
            </IconButton>
          </div>
        ) : null}
      </header>
      {(rules.length > 0 || session) && !form && (
        <div className="forwarding__group-actions">
          {rules.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !rules.some(canStart)}
              onClick={() => controller.start(rules.filter(canStart).map((rule) => rule.id))}
            >
              {t("forward.startAll")}
            </Button>
          )}
          {session && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => controller.requestDisconnect()}
            >
              {t("terminal.disconnect")}
            </Button>
          )}
        </div>
      )}
      {failure &&
        failure.target !== "editor" &&
        failure.target !== "list" &&
        !rules.some((rule) => rule.id === failure.target) && (
          <p role="alert" className="td-field__error">
            {failure.message}
          </p>
        )}
      {form ? (
        <ForwardRuleEditor
          key={`${host.id}:${form.id}:${form.revision ?? "new"}`}
          rule={form}
          groups={controller.groups}
          hostName={host.name}
          busy={busy}
          error={failure?.target === "editor" ? failure.message : undefined}
          onSave={controller.save}
          onCancel={controller.cancel}
        />
      ) : null}
      <ForwardingSurface hostId={host.id} title={host.name} controller={controller}>
        {loading ? (
          <p className="forwarding__empty" role="status">
            {t("common.loading")}
          </p>
        ) : (
          <ForwardGroups
            controller={controller}
            hostId={host.id}
            onEditGroup={(group) => setGroupEditor({ hostId: host.id, group })}
          />
        )}
      </ForwardingSurface>
      {failure?.target === "list" ? (
        <p role="alert" className="td-field__error">
          {failure.message}
        </p>
      ) : null}
      {groupEditor && (
        <ForwardGroupDialog
          key={groupEditor.group?.id ?? "new"}
          group={groupEditor.group}
          hostId={host.id}
          onClose={() => setGroupEditor(null)}
        />
      )}
      {connectingRules && (
        <ConnectDialog
          host={host}
          after="background"
          purpose="forwarding"
          onClose={controller.closeConnection}
          connectSession={(request, review) =>
            controller.connectAndStart(connectingRules, request, review)
          }
          onConnected={(connected) => controller.connected(connectingRules, connected)}
        />
      )}
    </section>
  );
}
