import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Laptop, Play, Plus, RefreshCw, Server, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Menu } from "@/components/ui/overlay/Menu";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { translateError } from "@/lib/api/errors";
import { copyText } from "@/lib/session/clipboard";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import type { Host } from "@/lib/api/types";
import type { RevisionedRule } from "./contract";
import { endpointAddress, localConnectionAddress, ForwardRuleEditor } from "./ForwardRuleEditor";
import "./forwarding.css";

import {
  forwardingStore,
  useForwardingSnapshot,
  type ForwardInfo,
  type ForwardRule,
} from "./forwardingStore";
export type { ForwardRule } from "./forwardingStore";

export function forwardingSavePayload(rule: ForwardRule): ForwardRule {
  const { id, hostId, name, mode, bindHost, bindPort, targetHost, targetPort } = rule;
  return { id, hostId, name, mode, bindHost, bindPort, targetHost, targetPort };
}
const initial = (hostId: string): ForwardRule => ({
  id: "",
  hostId,
  name: "",
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  targetHost: "127.0.0.1",
  targetPort: 80,
});

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
  return <SavedForwardingSection {...props} />;
}
function SavedForwardingSection({ host, embedded = false }: { host: Host; embedded?: boolean }) {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const session = sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
  const [connectingRules, setConnectingRules] = useState<RevisionedRule[] | null>(null);
  const snapshot = useForwardingSnapshot();
  const rules = (snapshot.entries ?? []).filter((rule) => rule.hostId === host.id);
  const loading = snapshot.entries === null && snapshot.busy;
  const load = forwardingStore.refresh;
  const isActive = (rule: ForwardInfo) =>
    rule.active && sessions.some((item) => item.id === rule.sessionId);
  const [form, setForm] = useState<(ForwardRule & { revision?: string }) | null>(null);
  const currentForm = useRef(form);
  useLayoutEffect(() => {
    currentForm.current = form;
  }, [form]);
  const [pending, setPending] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<"start" | "stop" | "save" | "remove">("start");
  const [operationFailure, setFailure] = useState<{ target: string; message: string } | null>(null);
  const mutation = useRef(false);
  const live = useRef(true);
  const confirm = useDialogs((state) => state.confirm);
  const failure =
    operationFailure ??
    (snapshot.error ? { target: "list", message: translateError(snapshot.error) } : null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = async (
    target: string,
    operation: () => Promise<unknown>,
    kind: typeof pendingKind = "start",
  ) => {
    if (mutation.current || !live.current) return;
    mutation.current = true;
    setPending(target);
    setPendingKind(kind);
    setFailure(null);
    try {
      await operation();
    } catch (cause) {
      if (live.current) setFailure({ target, message: translateError(cause) });
    } finally {
      // Also reconcile partial failures; the shared store coalesces native events and completion.
      load();
      mutation.current = false;
      if (live.current) setPending(null);
    }
  };
  const startOnConnection = (targets: RevisionedRule[], sessionId: string) => {
    void run(targets.length === 1 ? (targets[0]?.id ?? "group") : "group", async () => {
      const failures: string[] = [];
      for (const rule of targets) {
        try {
          if (!live.current) return;
          await invoke("forwarding_start", {
            id: rule.id,
            sessionId,
            expectedRevision: rule.revision,
          });
        } catch (cause) {
          if (targets.length === 1) throw cause;
          failures.push(`${rule.name}: ${translateError(cause)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("; "));
    });
  };
  const start = (ids: string[]) => {
    const targets = rules.filter((rule) => ids.includes(rule.id));
    const connected = useSsh
      .getState()
      .sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
    if (!connected) {
      setConnectingRules(targets);
      return;
    }
    startOnConnection(targets, connected.id);
  };
  const save = (rule: ForwardRule, start: boolean) => {
    if (mutation.current) return;
    const draft = form;
    if (!draft) return;
    const action = () =>
      run(
        "editor",
        async () => {
          if (currentForm.current !== draft || (draft.id && !draft.revision))
            throw new Error("forward.changed");
          const saved = await invoke<RevisionedRule>("forwarding_save", {
            rule: forwardingSavePayload(rule),
            ...(draft.id ? { expectedRevision: draft.revision } : {}),
          });
          forwardingStore.saved(saved);
          if (!live.current) return;
          setForm(null);
          if (start) {
            setPending(saved.id);
            setPendingKind("start");
            const connected = useSsh
              .getState()
              .sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
            if (!connected) setConnectingRules([saved]);
            else {
              try {
                await invoke("forwarding_start", {
                  id: saved.id,
                  sessionId: connected.id,
                  expectedRevision: saved.revision,
                });
              } catch (cause) {
                if (live.current) setFailure({ target: saved.id, message: translateError(cause) });
              }
            }
          }
        },
        "save",
      );
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(rule.bindHost.toLowerCase())) {
      confirm({
        title: t("forward.exposureTitle"),
        body: t("forward.exposureBody", { address: rule.bindHost }),
        confirmLabel: t(start ? "forward.saveStart" : "common.save"),
        danger: true,
        onConfirm: action,
      });
    } else void action();
  };
  const busy = pending !== null;
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
              onClick={() => {
                setFailure(null);
                void load();
              }}
            >
              <RefreshCw size={14} />
            </IconButton>
            <Button
              size="sm"
              leading={<Plus size={14} />}
              disabled={busy}
              onClick={() => {
                setFailure(null);
                setForm(initial(host.id));
              }}
            >
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
              onClick={() => start(rules.filter((rule) => !isActive(rule)).map((rule) => rule.id))}
            >
              {t("forward.startAll")}
            </Button>
          )}
          {session && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                confirm({
                  title: t("forward.disconnectTitle"),
                  body: t("forward.disconnectBody"),
                  confirmLabel: t("terminal.disconnect"),
                  onConfirm: () => useSsh.getState().disconnect(session.id),
                })
              }
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
        <>
          <ForwardRuleEditor
            rule={form}
            hostName={host.name}
            busy={busy}
            error={failure?.target === "editor" ? failure.message : undefined}
            onSave={save}
            onCancel={() => {
              setForm(null);
              setFailure(null);
            }}
          />
        </>
      ) : (
        <>
          {loading ? (
            <p className="forwarding__empty" role="status">
              {t("common.loading")}
            </p>
          ) : !rules.length && failure?.target !== "list" ? (
            <div className="forwarding__empty">
              <strong>{t("forward.noRules")}</strong>
            </div>
          ) : (
            <ul className="forward-rules" aria-label={t("forward.title")}>
              {rules.map((rule) => {
                const ruleError = failure?.target === rule.id ? failure.message : null;
                const local = rule.mode === "local";
                const active = isActive(rule);
                const starting =
                  pendingKind === "start" && (pending === rule.id || pending === "group");
                const stopping = pendingKind === "stop" && pending === rule.id;
                return (
                  <li key={rule.id} className="forward-rule">
                    <div className="forward-rule__head">
                      <div className="forward-rule__identity">
                        <strong>{rule.name}</strong>
                        <small>{t(local ? "forward.localPurpose" : "forward.remotePurpose")}</small>
                      </div>
                      <span
                        className={`forward-rule__status ${active ? "is-running" : ""}`}
                        role="status"
                      >
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
                        onClick={() =>
                          active
                            ? void run(
                                rule.id,
                                () => invoke("forwarding_stop", { id: rule.id }),
                                "stop",
                              )
                            : start([rule.id])
                        }
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
                            onSelect: () => {
                              setFailure(null);
                              setForm({ ...rule });
                            },
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
                            onSelect: () =>
                              confirm({
                                title: t("forward.deleteTitle"),
                                body: t("forward.deleteBody", { name: rule.name }),
                                confirmLabel: t("common.delete"),
                                danger: true,
                                onConfirm: () =>
                                  run(
                                    rule.id,
                                    () =>
                                      invoke("forwarding_remove", {
                                        id: rule.id,
                                        expectedRevision: rule.revision,
                                      }),
                                    "remove",
                                  ),
                              }),
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
          )}
        </>
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
          onClose={() => setConnectingRules(null)}
          onConnected={(connected) => {
            startOnConnection(connectingRules, connected.id);
          }}
        />
      )}
    </section>
  );
}
