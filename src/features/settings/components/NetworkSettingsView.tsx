import { useId, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input, Switch } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { presentError } from "@/lib/api/errors";
import type { NetworkSettings, ProxyProfile } from "@/lib/api/network";
import type { ProxyEdit } from "@/lib/api/credentials";
import type { SettingsControlState } from "./controlState";
import type { ReactNode } from "react";

export interface NetworkSettingsServices {
  useViewState: SettingsControlState;
  /** Credential drafts are memory-only, never ordinary serializable view state. */
  useSecretState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
  setDefaultProxy(value: string): Promise<boolean>;
  setFeatureProxy(feature: string, value: string): Promise<boolean>;
  removeProfile(id: string): Promise<boolean>;
  saveProfile(edit: ProxyEdit): Promise<{ credentialError: unknown | null }>;
  renderConnectionTest(settings: NetworkSettings): ReactNode;
}
export function NetworkSettingsView({
  settings,
  plugins,
  services,
}: {
  settings: NetworkSettings;
  plugins: readonly { id: string; name: string }[];
  services: NetworkSettingsServices;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const { useViewState, useSecretState, useBusyGuard } = services;
  const [editing, setEditing] = useViewState<ProxyProfile | null>("network:editing", null);
  const [password, setPassword] = useSecretState("network:password", "");
  const [clearPassword, setClearPassword] = useViewState("network:clearPassword", false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = saving;
  useBusyGuard(busy);
  const editingExisting = editing !== null && settings.profiles.some((p) => p.id === editing.id);
  const beginEditing = (profile: ProxyProfile) => {
    setEditing(profile);
    setPassword("");
    setClearPassword(false);
    setError("");
  };
  const choices = [
    { value: "", label: t("network.inherit") },
    { value: "system", label: t("network.system") },
    { value: "direct", label: t("network.direct") },
    ...settings.profiles.map((p) => ({ value: p.id, label: p.name })),
  ];
  const save = async () => {
    if (!editing || busy) return;
    setSaving(true);
    setError("");
    try {
      const result = await services.saveProfile({
        profile: editing,
        credential: clearPassword
          ? { action: "forget" }
          : password
            ? { action: "save", password }
            : { action: "keep" },
      });
      if (result.credentialError != null) {
        setError(presentError(result.credentialError));
        return;
      }
      setEditing(null);
      setPassword("");
    } catch (cause) {
      setError(presentError(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="network-settings">
      <p className="settings-section__intro">{t("network.intro")}</p>
      <section className="network-settings__section" aria-labelledby={`${formId}-default-title`}>
        <div className="network-settings__route">
          <div className="network-settings__description">
            <h3 id={`${formId}-default-title`}>{t("network.default")}</h3>
            <p className="settings-row__hint" id={`${formId}-default-hint`}>
              {t("network.systemHint")}
            </p>
          </div>
          <Select
            label={t("network.default")}
            descriptionId={`${formId}-default-hint`}
            disabled={busy}
            value={settings.defaultProxy || "system"}
            options={choices.filter((c) => c.value !== "")}
            onChange={(value) => void services.setDefaultProxy(value)}
          />
        </div>
      </section>
      <section className="network-settings__section" aria-labelledby={`${formId}-profiles-title`}>
        <div className="network-settings__head">
          <h3 id={`${formId}-profiles-title`}>{t("network.profiles")}</h3>
          <Button
            size="sm"
            variant="secondary"
            leading={<Plus size={14} />}
            disabled={editing !== null || busy}
            onClick={() =>
              beginEditing({
                id: crypto.randomUUID(),
                name: "",
                protocol: "http",
                host: "127.0.0.1",
                port: 7890,
                username: "",
              })
            }
          >
            {t("network.add")}
          </Button>
        </div>
        <div className="network-settings__profiles">
          {settings.profiles.length === 0 ? (
            <p className="network-settings__empty">{t("network.noProfiles")}</p>
          ) : null}
          {settings.profiles.map((profile) => (
            <div className="network-settings__profile" key={profile.id}>
              <div className="network-settings__description">
                <strong>{profile.name}</strong>
                <code>
                  {profile.protocol}://{profile.host}:{profile.port}
                </code>
              </div>
              <div className="network-settings__actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={editing !== null || busy}
                  onClick={() => beginEditing(profile)}
                >
                  {t("common.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost-danger"
                  disabled={editing !== null || busy}
                  onClick={() => void services.removeProfile(profile.id)}
                >
                  {t("common.delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
        {editing ? (
          <form
            className="network-settings__editor"
            aria-labelledby={`${formId}-edit-title`}
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h4 id={`${formId}-edit-title`}>
              {t(editingExisting ? "network.edit" : "network.add")}
            </h4>
            <fieldset disabled={busy} className="network-settings__fieldset">
              <legend>{t("network.connection")}</legend>
              <div className="network-settings__grid">
                <Field label={t("network.name")} htmlFor={`${formId}-name`}>
                  <Input
                    id={`${formId}-name`}
                    autoFocus
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </Field>
                <Field label={t("network.protocol")} htmlFor={`${formId}-protocol`}>
                  <Select
                    id={`${formId}-protocol`}
                    disabled={busy}
                    label={t("network.protocol")}
                    value={editing.protocol}
                    options={[
                      { value: "http", label: "HTTP CONNECT" },
                      { value: "socks5", label: "SOCKS5" },
                    ]}
                    onChange={(value) =>
                      setEditing({ ...editing, protocol: value as ProxyProfile["protocol"] })
                    }
                  />
                </Field>
              </div>
              <div className="network-settings__endpoint">
                <Field htmlFor={`${formId}-host`} label={t("network.address")}>
                  <Input
                    id={`${formId}-host`}
                    spellCheck={false}
                    autoComplete="off"
                    value={editing.host}
                    onChange={(e) => setEditing({ ...editing, host: e.target.value })}
                  />
                </Field>
                <Field htmlFor={`${formId}-port`} label={t("network.port")}>
                  <Input
                    id={`${formId}-port`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    value={editing.port}
                    onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })}
                  />
                </Field>
              </div>
            </fieldset>
            <fieldset disabled={busy} className="network-settings__fieldset">
              <legend>{t("network.authentication")}</legend>
              <div className="network-settings__grid">
                <Field htmlFor={`${formId}-username`} label={t("network.username")}>
                  <Input
                    id={`${formId}-username`}
                    autoComplete="off"
                    value={editing.username}
                    onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                  />
                </Field>
                <Field
                  htmlFor={`${formId}-password`}
                  label={t("network.password")}
                  hint={editingExisting ? t("network.passwordHint") : undefined}
                >
                  <Input
                    id={`${formId}-password`}
                    type="password"
                    autoComplete="new-password"
                    disabled={clearPassword}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </div>
              {editingExisting ? (
                <label className="network-settings__toggle">
                  <span>{t("network.clearPassword")}</span>
                  <Switch
                    label={t("network.clearPassword")}
                    checked={clearPassword}
                    onChange={setClearPassword}
                    disabled={busy}
                  />
                </label>
              ) : null}
            </fieldset>
            {error ? (
              <p role="alert" className="td-field__error">
                {error}
              </p>
            ) : null}
            <div className="network-settings__actions network-settings__editor-actions">
              <Button
                variant="primary"
                type="submit"
                disabled={
                  busy ||
                  !editing.name.trim() ||
                  !editing.host.trim() ||
                  !Number.isInteger(editing.port) ||
                  editing.port < 1 ||
                  editing.port > 65535
                }
              >
                {t("common.save")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setPassword("");
                  setError("");
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
      <section className="network-settings__section" aria-labelledby={`${formId}-features-title`}>
        <div className="network-settings__head">
          <h3 id={`${formId}-features-title`}>{t("network.features")}</h3>
        </div>
        <div className="network-settings__routes">
          {(["updates", "marketplace", "ssh", "processes"] as const).map((feature) => (
            <div key={feature} className="network-settings__route">
              <label htmlFor={`${formId}-${feature}`}>{t(`network.${feature}`)}</label>
              <Select
                id={`${formId}-${feature}`}
                label={t(`network.${feature}`)}
                disabled={busy}
                value={settings.features[feature] ?? ""}
                options={choices}
                onChange={(value) => void services.setFeatureProxy(feature, value)}
              />
            </div>
          ))}
        </div>
        <details className="network-settings__plugins">
          <summary>
            <ChevronRight size={14} aria-hidden="true" />
            {t("network.plugins")}
            <span className="network-settings__count">{plugins.length}</span>
          </summary>
          <div className="network-settings__routes">
            {plugins.length === 0 ? (
              <p className="network-settings__empty">{t("network.noPlugins")}</p>
            ) : null}
            {plugins.map((plugin) => (
              <div key={plugin.id} className="network-settings__route">
                <label htmlFor={`${formId}-plugin-${plugin.id}`}>{plugin.name}</label>
                <Select
                  id={`${formId}-plugin-${plugin.id}`}
                  label={plugin.name}
                  disabled={busy}
                  value={settings.features[`plugin:${plugin.id}`] ?? ""}
                  options={choices}
                  onChange={(value) => void services.setFeatureProxy(`plugin:${plugin.id}`, value)}
                />
              </div>
            ))}
          </div>
        </details>
        <p className="settings-row__hint network-settings__note">{t("network.processHint")}</p>
      </section>
      {services.renderConnectionTest(settings)}
    </div>
  );
}
