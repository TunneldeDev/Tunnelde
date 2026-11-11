import { ArrowRight, Laptop, Play, Server, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { Menu } from "@/components/ui/overlay/Menu";
import { copyText } from "@/lib/session/clipboard";
import { endpointAddress, localConnectionAddress } from "../model/endpoint";
import type { ForwardingController } from "../runtime/useForwardingController";

/** Native rows use host controller actions; presentation does not own IPC or dialogs. */
export function ForwardingEntries({
  rules,
  failure,
  pendingKind,
  pending,
  isActive,
  busy,
  start,
  stop,
  edit,
  requestRemove,
}: Pick<
  ForwardingController,
  | "rules"
  | "failure"
  | "pendingKind"
  | "pending"
  | "isActive"
  | "busy"
  | "start"
  | "stop"
  | "edit"
  | "requestRemove"
>) {
  const { t } = useTranslation();
  return (
    <ul className="forward-rules" aria-label={t("forward.title")}>
      {rules.map((rule) => {
        const ruleError = failure?.target === rule.id ? failure.message : null;
        const local = rule.mode === "local";
        const active = isActive(rule);
        const starting = pendingKind === "start" && (pending === rule.id || pending === "group");
        const stopping = pendingKind === "stop" && pending === rule.id;
        return (
          <li key={rule.id} className="forward-rule">
            <div className="forward-rule__head">
              <div className="forward-rule__identity">
                <strong>{rule.name}</strong>
                <small>{t(local ? "forward.localPurpose" : "forward.remotePurpose")}</small>
              </div>
              <span className={`forward-rule__status ${active ? "is-running" : ""}`} role="status">
                {t(
                  starting
                    ? "forward.starting"
                    : stopping
                      ? "forward.stopping"
                      : active
                        ? "forward.running"
                        : "forward.stopped",
                )}
              </span>
              <IconButton
                size="sm"
                label={t(
                  stopping || starting
                    ? stopping
                      ? "forward.stopping"
                      : "forward.starting"
                    : active
                      ? "forward.stop"
                      : "forward.start",
                )}
                disabled={busy}
                onClick={() => (active ? void stop(rule) : start([rule.id]))}
              >
                {active ? <Square size={14} /> : <Play size={14} />}
              </IconButton>
              <Menu
                label={t("forward.ruleActions", { name: rule.name })}
                disabled={busy}
                items={[
                  {
                    label: t("common.edit"),
                    disabled: active,
                    description: active ? t("forward.stopBeforeEdit") : undefined,
                    onSelect: () => edit(rule),
                  },
                  ...(local
                    ? [
                        {
                          label: t("forward.copyAddress"),
                          onSelect: () =>
                            copyText(localConnectionAddress(rule.bindHost, rule.bindPort)),
                        },
                      ]
                    : []),
                  {
                    label: t("common.delete"),
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => requestRemove(rule),
                  },
                ]}
              />
            </div>
            <div className="forward-rule__route">
              <div>
                {local ? <Laptop size={13} /> : <Server size={13} />}
                <span>{t(local ? "forward.localEndpoint" : "forward.remoteEndpoint")}</span>
                <code>{endpointAddress(rule.bindHost, rule.bindPort)}</code>
              </div>
              <ArrowRight size={15} aria-hidden="true" />
              <div>
                {local ? <Server size={13} /> : <Laptop size={13} />}
                <span>{t(local ? "forward.remoteEndpoint" : "forward.localEndpoint")}</span>
                <code>{endpointAddress(rule.targetHost, rule.targetPort)}</code>
              </div>
            </div>
            {ruleError ? (
              <p role="alert" className="td-field__error">
                {ruleError}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
