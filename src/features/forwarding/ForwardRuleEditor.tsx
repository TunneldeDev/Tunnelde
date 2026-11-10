import { ArrowRight, Laptop, Server } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import type { ForwardRule } from "./contract";

export function endpointAddress(host: string, port: number | string): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export function localConnectionAddress(host: string, port: number | string): string {
  return endpointAddress(host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port);
}

export function ForwardRuleEditor({
  rule,
  hostName,
  busy,
  error,
  onSave,
  onCancel,
}: {
  rule: ForwardRule;
  hostName: string;
  busy: boolean;
  error?: string;
  onSave: (rule: ForwardRule, start: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [form, setForm] = useState({
    ...rule,
    bindPort: String(rule.bindPort),
    targetPort: String(rule.targetPort),
  });
  const local = form.mode === "local";
  const prefix = `forward.${form.mode}` as const;
  return (
    <form
      className="forward-editor"
      aria-label={t(rule.id ? "forward.editRule" : "forward.add")}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        onSave(
          {
            ...form,
            name:
              form.name.trim() ||
              endpointAddress(form.targetHost.trim(), form.targetPort).slice(0, 120),
            bindHost: form.bindHost.trim(),
            targetHost: form.targetHost.trim(),
            bindPort: Number(form.bindPort),
            targetPort: Number(form.targetPort),
          },
          submitter instanceof HTMLButtonElement && submitter.value === "start",
        );
      }}
    >
      <h3 className="forward-editor__title">{t(rule.id ? "forward.editRule" : "forward.add")}</h3>
      <fieldset className="forward-editor__fields" disabled={busy}>
        <fieldset className="forward-direction">
          <legend>{t("forward.purpose")}</legend>
          {(["local", "remote"] as const).map((mode) => (
            <label
              key={mode}
              className={`forward-direction__choice ${form.mode === mode ? "is-selected" : ""}`}
            >
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={form.mode === mode}
                onChange={() => setForm({ ...form, mode })}
              />
              <span>
                <strong>{t(`forward.${mode}Purpose`)}</strong>
                <small>{t(`forward.${mode}Flow`)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="forward-endpoints">
          <fieldset className="forward-endpoint">
            <legend>
              {local ? <Laptop size={14} /> : <Server size={14} />}
              {t("forward.listener")}
            </legend>
            <p className="forward-endpoint__machine">
              {local ? t("forward.thisComputer") : hostName}
            </p>
            <Field label={t(`${prefix}BindHost`)} htmlFor={`${id}-bind-host`}>
              <Input
                id={`${id}-bind-host`}
                required
                value={form.bindHost}
                onChange={(event) => setForm({ ...form, bindHost: event.target.value })}
              />
            </Field>
            <Field label={t(`${prefix}BindPort`)} htmlFor={`${id}-bind-port`}>
              <Input
                id={`${id}-bind-port`}
                required
                type="number"
                min={1}
                max={65535}
                step={1}
                value={form.bindPort}
                onChange={(event) => setForm({ ...form, bindPort: event.target.value })}
              />
            </Field>
          </fieldset>
          <ArrowRight className="forward-endpoints__arrow" size={18} aria-hidden="true" />
          <fieldset className="forward-endpoint">
            <legend>
              {local ? <Server size={14} /> : <Laptop size={14} />}
              {t("forward.destination")}
            </legend>
            <p className="forward-endpoint__machine">
              {local ? hostName : t("forward.thisComputer")}
            </p>
            <Field label={t(`${prefix}TargetHost`)} htmlFor={`${id}-target-host`}>
              <Input
                id={`${id}-target-host`}
                required
                value={form.targetHost}
                onChange={(event) => setForm({ ...form, targetHost: event.target.value })}
              />
            </Field>
            <Field label={t(`${prefix}TargetPort`)} htmlFor={`${id}-target-port`}>
              <Input
                id={`${id}-target-port`}
                required
                type="number"
                min={1}
                max={65535}
                step={1}
                value={form.targetPort}
                onChange={(event) => setForm({ ...form, targetPort: event.target.value })}
              />
            </Field>
          </fieldset>
        </div>
        <p className="forward-help">{t(local ? "forward.localHint" : "forward.remoteHint")}</p>
        <Field label={t("forward.name")} hint={t("forward.nameHint")} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            maxLength={120}
            value={form.name}
            placeholder={endpointAddress(form.targetHost, form.targetPort)}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        {local ? (
          <p className="forward-connect-hint">
            {t("forward.connectTo", {
              address: localConnectionAddress(form.bindHost, form.bindPort),
            })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="td-field__error">
            {error}
          </p>
        ) : null}
        <div className="forward-editor__actions">
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" value="save" variant="secondary">
            {t("common.save")}
          </Button>
          <Button type="submit" value="start" variant="primary">
            {t("forward.saveStart")}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
