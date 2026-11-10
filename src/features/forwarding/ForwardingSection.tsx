import { Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { useDialogs } from "@/store/dialogs";
import type { Host } from "@/lib/api/types";
import { ForwardRuleEditor } from "./components/ForwardRuleEditor";
import { ForwardingEntries } from "./components/ForwardingEntries";
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
  return <SavedForwardingSection key={props.host.id} {...props} />;
}
function SavedForwardingSection({ host, embedded = false }: { host: Host; embedded?: boolean }) {
  const { t } = useTranslation();
  const controller = useForwardingController(host);
  const { rules, loading, session, isActive, form, busy, failure, connectingRules } = controller;
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
            <IconButton
              label={t("forward.refresh")}
              disabled={busy || loading}
              onClick={controller.refresh}
            >
              <RefreshCw size={14} />
            </IconButton>
            <Button size="sm" leading={<Plus size={14} />} disabled={busy} onClick={controller.add}>
              {t("forward.add")}
            </Button>
          </div>
        ) : null}
      </header>
      {(rules.length > 0 || session) && !form && (
        <div className="forwarding__group-actions">
          {rules.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || rules.every(isActive)}
              onClick={() =>
                controller.start(rules.filter((rule) => !isActive(rule)).map((rule) => rule.id))
              }
            >
              {t("forward.startAll")}
            </Button>
          )}
          {session && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={controller.requestDisconnect}
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
          rule={form}
          hostName={host.name}
          busy={busy}
          error={failure?.target === "editor" ? failure.message : undefined}
          onSave={controller.save}
          onCancel={controller.cancel}
        />
      ) : loading ? (
        <p className="forwarding__empty" role="status">
          {t("common.loading")}
        </p>
      ) : !rules.length && failure?.target !== "list" ? (
        <div className="forwarding__empty">
          <strong>{t("forward.noRules")}</strong>
        </div>
      ) : (
        <ForwardingEntries {...controller} />
      )}
      {failure?.target === "list" ? (
        <p role="alert" className="td-field__error">
          {failure.message}
        </p>
      ) : null}
      {connectingRules && (
        <ConnectDialog
          host={host}
          after="background"
          purpose="forwarding"
          onClose={controller.closeConnection}
          onConnected={(connected) => controller.startOnConnection(connectingRules, connected.id)}
        />
      )}
    </section>
  );
}
