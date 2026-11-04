import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import type { Host } from "@/lib/api/types";

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
  const id = useId();
  const sessions = useSsh((s) => s.sessions);
  const available = sessions.filter((s) => s.hostId === host.id);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const session = available.find((s) => s.id === sessionId) ?? available[0];
  const [rules, setRules] = useState<ForwardInfo[]>([]);
  const [form, setForm] = useState<ForwardRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = useDialogs((s) => s.confirm);
  const openConnect = useDialogs((s) => s.openConnect);
  const load = async () => {
    if (isTauri())
      setRules(
        (await invoke<ForwardInfo[]>("forwarding_list")).filter((r) => r.hostId === host.id),
      );
  };
  useEffect(() => {
    let live = true;
    if (isTauri())
      void invoke<ForwardInfo[]>("forwarding_list")
        .then((rows) => {
          if (live) setRules(rows.filter((r) => r.hostId === host.id));
        })
        .catch((cause) => {
          if (live) setError(translateError(cause));
        });
    return () => {
      live = false;
    };
  }, [host.id, sessions]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!form) return;
    const rule = {
      ...form,
      name: form.name.trim(),
      bindHost: form.bindHost.trim(),
      targetHost: form.targetHost.trim(),
    };
    const action = () =>
      run(async () => {
        await invoke("forwarding_save", { rule });
        setForm(null);
      });
    const exposed = !["localhost", "127.0.0.1", "::1"].includes(rule.bindHost);
    if (exposed)
      confirm({
        title: t("forward.exposureTitle"),
        body: t("forward.exposureBody", { address: rule.bindHost }),
        confirmLabel: t("common.save"),
        danger: true,
        onConfirm: action,
      });
    else await action();
  };
  return (
    <section className={embedded ? undefined : "card"}>
      <div className="field-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h2 className="card__title">{embedded ? host.name : t("forward.title")}</h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => setForm(initial(host.id))}
        >
          {t("forward.add")}
        </Button>
      </div>
      <p className="td-field__hint">{t("forward.hint")}</p>
      {available.length > 1 ? (
        <Field label={t("forward.session")}>
          <Select
            label={t("forward.session")}
            value={session?.id ?? ""}
            options={available.map((s) => ({ value: s.id, label: s.title }))}
            onChange={setSessionId}
          />
        </Field>
      ) : null}
      {!session && rules.length ? (
        <Button size="sm" variant="secondary" onClick={() => openConnect(host)}>
          {t("terminal.connect")}
        </Button>
      ) : null}
      {rules.map((rule) => (
        <div
          key={rule.id}
          className="settings-preference-group"
          style={{ padding: "10px 0", borderBottom: "1px solid var(--td-border)" }}
        >
          <div className="field-row" style={{ flexWrap: "wrap" }}>
            <strong style={{ flex: "1 1 140px", overflowWrap: "anywhere" }}>{rule.name}</strong>
            <span>{t(rule.mode === "local" ? "forward.local" : "forward.remote")}</span>
            <span role="status">{t(rule.active ? "forward.running" : "forward.stopped")}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || (!rule.active && !session)}
              onClick={() =>
                void run(() =>
                  invoke(rule.active ? "forwarding_stop" : "forwarding_start", {
                    id: rule.id,
                    ...(!rule.active ? { sessionId: session?.id } : {}),
                  }),
                )
              }
            >
              {t(rule.active ? "forward.stop" : "forward.start")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || rule.active}
              onClick={() =>
                setForm({
                  id: rule.id,
                  hostId: rule.hostId,
                  name: rule.name,
                  mode: rule.mode,
                  bindHost: rule.bindHost,
                  bindPort: rule.bindPort,
                  targetHost: rule.targetHost,
                  targetPort: rule.targetPort,
                })
              }
            >
              {t("common.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost-danger"
              disabled={busy}
              onClick={() =>
                confirm({
                  title: t("forward.deleteTitle"),
                  body: t("forward.deleteBody", { name: rule.name }),
                  confirmLabel: t("common.delete"),
                  danger: true,
                  onConfirm: () => run(() => invoke("forwarding_remove", { id: rule.id })),
                })
              }
            >
              {t("common.delete")}
            </Button>
          </div>
          <code style={{ display: "block", overflowWrap: "anywhere", marginTop: 6 }}>
            {t(rule.mode === "local" ? "forward.localEndpoint" : "forward.remoteEndpoint")}{" "}
            {rule.bindHost}:{rule.bindPort} →{" "}
            {t(rule.mode === "local" ? "forward.remoteEndpoint" : "forward.localEndpoint")}{" "}
            {rule.targetHost}:{rule.targetPort}
          </code>
        </div>
      ))}
      {!rules.length && !form ? <p className="td-field__hint">{t("forward.empty")}</p> : null}
      {form ? (
        <form
          className="form-grid"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t("forward.name")} htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label={t("forward.mode")}
            hint={t(form.mode === "local" ? "forward.localHint" : "forward.remoteHint")}
          >
            <Select
              label={t("forward.mode")}
              value={form.mode}
              options={[
                { value: "local", label: t("forward.local") },
                { value: "remote", label: t("forward.remote") },
              ]}
              onChange={(v) => setForm({ ...form, mode: v as ForwardRule["mode"] })}
            />
          </Field>
          <div className="form-row">
            <Field
              label={t(`forward.${form.mode === "local" ? "local" : "remote"}BindHost`)}
              className="grow"
              htmlFor={`${id}-bind-host`}
            >
              <Input
                id={`${id}-bind-host`}
                required
                value={form.bindHost}
                onChange={(e) => setForm({ ...form, bindHost: e.target.value })}
              />
            </Field>
            <Field
              label={t(`forward.${form.mode === "local" ? "local" : "remote"}BindPort`)}
              className="port"
              htmlFor={`${id}-bind-port`}
            >
              <Input
                id={`${id}-bind-port`}
                required
                type="number"
                min={1}
                max={65535}
                value={form.bindPort}
                onChange={(e) => setForm({ ...form, bindPort: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="form-row">
            <Field
              label={t(`forward.${form.mode === "local" ? "local" : "remote"}TargetHost`)}
              className="grow"
              htmlFor={`${id}-target-host`}
            >
              <Input
                id={`${id}-target-host`}
                required
                value={form.targetHost}
                onChange={(e) => setForm({ ...form, targetHost: e.target.value })}
              />
            </Field>
            <Field
              label={t(`forward.${form.mode === "local" ? "local" : "remote"}TargetPort`)}
              className="port"
              htmlFor={`${id}-target-port`}
            >
              <Input
                id={`${id}-target-port`}
                required
                type="number"
                min={1}
                max={65535}
                value={form.targetPort}
                onChange={(e) => setForm({ ...form, targetPort: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="field-row">
            <Button type="submit" variant="primary" disabled={busy}>
              {t("common.save")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setForm(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="td-field__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
