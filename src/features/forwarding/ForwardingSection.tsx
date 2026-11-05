import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Laptop, Play, Plus, RefreshCw, Server, Square } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Field } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { Menu } from "@/components/ui/overlay/Menu";
import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { copyText } from "@/lib/session/clipboard";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import type { Host } from "@/lib/api/types";
import { endpointAddress, localConnectionAddress, ForwardRuleEditor } from "./ForwardRuleEditor";
import "./forwarding.css";

export interface ForwardRule {
  id: string;
  hostId: string;
  name: string;
  mode: "local" | "remote";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
}
export function forwardingSavePayload(rule: ForwardRule): ForwardRule {
  const { id, hostId, name, mode, bindHost, bindPort, targetHost, targetPort } = rule;
  return { id, hostId, name, mode, bindHost, bindPort, targetHost, targetPort };
}
interface ForwardInfo extends ForwardRule {
  active: boolean;
  sessionId: string | null;
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

export function ForwardingSection({
  host,
  initialSessionId = "",
  embedded = false,
}: {
  host: Host;
  initialSessionId?: string;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const origin = useId();
  const sessions = useSsh((state) => state.sessions);
  const available = sessions.filter((session) => session.hostId === host.id);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const session = available.find((item) => item.id === sessionId) ?? available[0];
  const [rules, setRules] = useState<ForwardInfo[]>([]);
  const [form, setForm] = useState<ForwardRule | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null);
  const mutation = useRef(false);
  const generation = useRef(0);
  const live = useRef(true);
  const confirm = useDialogs((state) => state.confirm);
  const openConnect = useDialogs((state) => state.openConnect);
  const load = useCallback(() => {
    const request = ++generation.current;
    const result = isTauri()
      ? invoke<ForwardInfo[]>("forwarding_list")
      : Promise.resolve<ForwardInfo[]>([]);
    return result.then(
      (rows) => {
        if (live.current && request === generation.current) {
          setRules(rows.filter((rule) => rule.hostId === host.id));
          setLoading(false);
        }
      },
      (cause: unknown) => {
        if (live.current && request === generation.current) {
          setLoading(false);
          setFailure({ target: "list", message: translateError(cause) });
        }
      },
    );
  }, [host.id]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load, sessions]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; origin: string }>).detail;
      if (detail?.hostId === host.id && detail.origin !== origin && !mutation.current) void load();
    };
    window.addEventListener("tunnelde:forwarding-changed", changed);
    return () => window.removeEventListener("tunnelde:forwarding-changed", changed);
  }, [host.id, load, origin]);
  const run = async (target: string, operation: () => Promise<unknown>) => {
    if (mutation.current) return;
    mutation.current = true;
    setPending(target);
    setFailure(null);
    // Older list requests cannot replace the result of this mutation.
    generation.current++;
    try {
      await operation();
    } catch (cause) {
      if (live.current) setFailure({ target, message: translateError(cause) });
    } finally {
      if (live.current) await load();
      window.dispatchEvent(
        new CustomEvent("tunnelde:forwarding-changed", { detail: { hostId: host.id, origin } }),
      );
      mutation.current = false;
      if (live.current) setPending(null);
    }
  };
  const save = (rule: ForwardRule, start: boolean) => {
    if (mutation.current) return;
    const action = () =>
      run("editor", async () => {
        const saved = await invoke<ForwardRule>("forwarding_save", {
          rule: forwardingSavePayload(rule),
        });
        if (!live.current) return;
        generation.current++;
        setRules((current) => [
          ...current.filter((item) => item.id !== saved.id),
          { ...saved, active: false, sessionId: null },
        ]);
        setLoading(false);
        setForm(null);
        if (start) {
          setPending(saved.id);
          const connected = useSsh
            .getState()
            .sessions.find((item) => item.id === session?.id && item.hostId === host.id);
          try {
            if (!connected) throw new Error(t("forward.connectionRequired"));
            await invoke("forwarding_start", { id: saved.id, sessionId: connected.id });
          } catch (cause) {
            // Saving succeeded: show a retryable error on the saved rule, never create it twice.
            if (live.current) setFailure({ target: saved.id, message: translateError(cause) });
          }
        }
      });
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
          <h2 className="card__title">{embedded ? host.name : t("forward.title")}</h2>
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
      <div className={`forward-connection ${session ? "is-connected" : ""}`}>
        <Server size={14} aria-hidden="true" />
        <span>{t(session ? "forward.connected" : "forward.connectionRequired")}</span>
        {!session ? (
          <Button size="sm" disabled={busy} onClick={() => openConnect(host, "background")}>
            {t("terminal.connect")}
          </Button>
        ) : session.terminal === false ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              confirm({
                title: t("forward.disconnectTitle"),
                body: t("forward.disconnectBody"),
                confirmLabel: t("terminal.disconnect"),
                onConfirm: () => useSsh.getState().disconnect(session.id),
              });
            }}
          >
            {t("terminal.disconnect")}
          </Button>
        ) : null}
      </div>
      {available.length > 1 ? (
        <Field label={t("forward.session")}>
          <Select
            label={t("forward.session")}
            disabled={busy}
            value={session?.id ?? ""}
            options={available.map((item, index) => ({
              value: item.id,
              label: t("forward.sessionLabel", { name: item.title, index: index + 1 }),
            }))}
            onChange={setSessionId}
          />
        </Field>
      ) : null}
      {form ? (
        <>
          <ForwardRuleEditor
            rule={form}
            hostName={host.name}
            connected={!!session}
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
              <ArrowRight size={24} aria-hidden="true" />
              <strong>{t("forward.noRules")}</strong>
              <p>{t("forward.empty")}</p>
            </div>
          ) : (
            <ul className="forward-rules" aria-label={t("forward.title")}>
              {rules.map((rule) => {
                const ruleError = failure?.target === rule.id ? failure.message : null;
                const local = rule.mode === "local";
                const owner = available.find((item) => item.id === rule.sessionId);
                return (
                  <li key={rule.id} className="forward-rule">
                    <div className="forward-rule__head">
                      <div className="forward-rule__identity">
                        <strong>{rule.name}</strong>
                        <small>{t(local ? "forward.localPurpose" : "forward.remotePurpose")}</small>
                      </div>
                      <span
                        className={`forward-rule__status ${rule.active ? "is-running" : ""}`}
                        role="status"
                      >
                        {t(rule.active ? "forward.running" : "forward.stopped")}
                      </span>
                      <Button
                        size="sm"
                        variant={rule.active ? "secondary" : "primary"}
                        leading={rule.active ? <Square size={12} /> : <Play size={12} />}
                        disabled={busy || (!rule.active && !session)}
                        onClick={() =>
                          void run(rule.id, () =>
                            invoke(rule.active ? "forwarding_stop" : "forwarding_start", {
                              id: rule.id,
                              ...(!rule.active ? { sessionId: session?.id } : {}),
                            }),
                          )
                        }
                      >
                        {t(
                          pending === rule.id
                            ? rule.active
                              ? "forward.stopping"
                              : "forward.starting"
                            : rule.active
                              ? "forward.stop"
                              : "forward.start",
                        )}
                      </Button>
                      <Menu
                        label={t("forward.ruleActions", { name: rule.name })}
                        disabled={busy}
                        items={[
                          {
                            label: t("common.edit"),
                            disabled: rule.active,
                            description: rule.active ? t("forward.stopBeforeEdit") : undefined,
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
                                  run(rule.id, () => invoke("forwarding_remove", { id: rule.id })),
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
                    {local && rule.active ? (
                      <p className="forward-rule__hint">
                        {t("forward.connectTo", {
                          address: localConnectionAddress(rule.bindHost, rule.bindPort),
                        })}
                      </p>
                    ) : null}
                    {rule.active && available.length > 1 && owner ? (
                      <p className="forward-rule__hint">
                        {t("forward.runningSession", {
                          name: t("forward.sessionLabel", {
                            name: owner.title,
                            index: available.indexOf(owner) + 1,
                          }),
                        })}
                      </p>
                    ) : null}
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
          <p className="forward-help">{t("forward.hint")}</p>
        </>
      )}
      {failure?.target === "list" ? (
        <p role="alert" className="td-field__error">
          {failure.message}
        </p>
      ) : null}
    </section>
  );
}
