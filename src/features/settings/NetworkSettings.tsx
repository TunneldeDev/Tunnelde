import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input, Switch } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { defaultNetwork, type ProxyProfile } from "@/lib/api/network";

export function NetworkSettingsSection() {
  const { t } = useTranslation();
  const formId = useId();
  const settings = useSettings((s) => s.settings.network) ?? defaultNetwork();
  const update = useSettings((s) => s.update);
  const plugins = usePlugins((s) => s.items);
  const [editing, setEditing] = useState<ProxyProfile | null>(null);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testProxy, setTestProxy] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testHost, setTestHost] = useState("github.com");
  const [testPort, setTestPort] = useState("443");
  const [result, setResult] = useState("");
  const choices = [
    { value: "", label: t("network.inherit") },
    { value: "system", label: t("network.system") },
    { value: "direct", label: t("network.direct") },
    ...settings.profiles.map((p) => ({ value: p.id, label: p.name })),
  ];
  const save = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError("");
    try {
      const profiles = settings.profiles.some((p) => p.id === editing.id)
        ? settings.profiles.map((p) => (p.id === editing.id ? editing : p))
        : [...settings.profiles, editing];
      if (!(await update({ network: { ...settings, profiles } }))) return;
      if (!useSettings.getState().settings.network.profiles.some((p) => p.id === editing.id))
        return;
      if (password || clearPassword)
        await api.saveProxyPassword(editing.id, clearPassword ? null : password);
      setEditing(null);
      setPassword("");
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="network-settings">
      <p className="settings-section__intro">{t("network.intro")}</p>
      <p className="settings-row__hint">{t("network.systemHint")}</p>
      <Field label={t("network.default")}>
        <Select
          label={t("network.default")}
          value={settings.defaultProxy || "system"}
          options={choices.filter((c) => c.value !== "")}
          onChange={(value) => void update({ network: { ...settings, defaultProxy: value } })}
        />
      </Field>
      <section className="settings-preference-group">
        <h3 className="settings-preference-group__title">{t("network.profiles")}</h3>
        <div className="settings-preference-group__body">
          {settings.profiles.map((profile) => (
            <div className="settings-row" key={profile.id}>
              <div className="settings-row__text">
                <strong>{profile.name}</strong>
                <code>
                  {profile.protocol}://{profile.host}:{profile.port}
                </code>
              </div>
              <div className="field-row">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(profile);
                    setPassword("");
                    setClearPassword(false);
                    setError("");
                  }}
                >
                  {t("common.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost-danger"
                  onClick={() => {
                    const features = Object.fromEntries(
                      Object.entries(settings.features).map(([k, v]) => [
                        k,
                        v === profile.id ? "" : v,
                      ]),
                    );
                    void update({
                      network: {
                        ...settings,
                        profiles: settings.profiles.filter((p) => p.id !== profile.id),
                        features,
                        defaultProxy:
                          settings.defaultProxy === profile.id ? "system" : settings.defaultProxy,
                      },
                    });
                  }}
                >
                  {t("common.delete")}
                </Button>
              </div>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing({
                id: crypto.randomUUID(),
                name: "",
                protocol: "http",
                host: "127.0.0.1",
                port: 7890,
                username: "",
              });
              setPassword("");
              setClearPassword(false);
            }}
          >
            {t("network.add")}
          </Button>
        </div>
      </section>
      {editing ? (
        <section className="settings-preference-group">
          <h3 className="settings-preference-group__title">{t("network.edit")}</h3>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field label={t("network.name")} htmlFor={`${formId}-name`}>
              <Input
                id={`${formId}-name`}
                autoFocus
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label={t("network.protocol")}>
              <Select
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
            <Field htmlFor={`${formId}-host`} label={t("network.address")}>
              <Input
                id={`${formId}-host`}
                spellCheck={false}
                value={editing.host}
                onChange={(e) => setEditing({ ...editing, host: e.target.value })}
              />
            </Field>
            <Field htmlFor={`${formId}-port`} label={t("network.port")}>
              <Input
                id={`${formId}-port`}
                type="number"
                min={1}
                max={65535}
                value={editing.port}
                onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })}
              />
            </Field>
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
              hint={t("network.passwordHint")}
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
            <Switch
              label={t("network.clearPassword")}
              checked={clearPassword}
              onChange={setClearPassword}
            />
            <div className="field-row">
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
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        </section>
      ) : null}
      <section className="settings-preference-group">
        <h3 className="settings-preference-group__title">{t("network.features")}</h3>
        <div className="settings-preference-group__body">
          {(["updates", "marketplace", "ssh", "processes"] as const).map((feature) => (
            <Field key={feature} label={t(`network.${feature}`)}>
              <Select
                label={t(`network.${feature}`)}
                value={settings.features[feature] ?? ""}
                options={choices}
                onChange={(value) =>
                  void update({
                    network: { ...settings, features: { ...settings.features, [feature]: value } },
                  })
                }
              />
            </Field>
          ))}
          <details>
            <summary>{t("network.plugins")}</summary>
            {plugins.map((plugin) => (
              <Field key={plugin.id} label={plugin.name}>
                <Select
                  label={plugin.name}
                  value={settings.features[`plugin:${plugin.id}`] ?? ""}
                  options={choices}
                  onChange={(value) =>
                    void update({
                      network: {
                        ...settings,
                        features: { ...settings.features, [`plugin:${plugin.id}`]: value },
                      },
                    })
                  }
                />
              </Field>
            ))}
          </details>
          <p className="settings-row__hint">{t("network.processHint")}</p>
        </div>
      </section>
      <section className="settings-preference-group">
        <h3 className="settings-preference-group__title">{t("network.test")}</h3>
        <Field label={t("network.proxy")}>
          <Select
            label={t("network.proxy")}
            value={testProxy}
            options={choices}
            onChange={setTestProxy}
          />
        </Field>
        <div className="field-row">
          <Input
            aria-label={t("network.address")}
            value={testHost}
            onChange={(e) => setTestHost(e.target.value)}
          />
          <Input
            aria-label={t("network.port")}
            type="number"
            value={testPort}
            onChange={(e) => setTestPort(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setResult("");
              try {
                await api.testProxy(
                  testProxy || settings.defaultProxy || "system",
                  testHost,
                  Number(testPort),
                );
                setResult(t("network.testSuccess"));
              } catch (cause) {
                setResult(translateError(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("network.test")}
          </Button>
        </div>
        <p role="status">{result}</p>
      </section>
      {error ? (
        <p role="alert" className="td-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
