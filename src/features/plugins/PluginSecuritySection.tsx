import { useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Switch } from "@/components/ui/form/Field";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { PluginPermissionList } from "./PluginPermissionGate";
import { PluginError } from "./PluginError";

function openSecurity() {
  useNavigation.getState().selectSettings("plugins");
  useWorkspace.getState().openPage("settings");
}

export function PluginSecurityBadge() {
  const { t } = useTranslation();
  const { state, failure, recoveryDismissed } = usePluginSecurity();
  if (!state.restricted && !failure && (!state.recoverySuggested || recoveryDismissed)) return null;
  return (
    <button
      type="button"
      className="statusbar__link plugin-security-badge"
      onClick={openSecurity}
      title={t("pluginSecurity.title")}
    >
      <ShieldAlert size={12} />
      {t(state.restricted ? "pluginSecurity.restricted" : "pluginSecurity.review")}
    </button>
  );
}

export function PluginRestrictedAction() {
  const { t } = useTranslation();
  const { state, busy, setRestricted } = usePluginSecurity();
  return state.restricted ? null : (
    <Button size="sm" disabled={busy} onClick={() => void setRestricted(true)}>
      {t("pluginSecurity.enterRestricted")}
    </Button>
  );
}

export function PluginSecuritySection() {
  const { t } = useTranslation();
  const {
    state,
    ready,
    loading,
    busy,
    error,
    failure,
    recoveryDismissed,
    load,
    setRestricted,
    revoke,
    dismissRecovery,
  } = usePluginSecurity();
  const plugins = usePlugins((value) => value.items);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="settings-subsection plugin-security" aria-label={t("pluginSecurity.title")}>
      <div className="settings-section__head">
        <h3 className="settings-subtitle">{t("pluginSecurity.title")}</h3>
        <Switch
          label={t("pluginSecurity.restricted")}
          checked={state.restricted}
          disabled={!ready || loading || busy || state.cliLocked}
          onChange={(enabled) => void setRestricted(enabled)}
        />
      </div>
      <p className="settings-hint">{t("pluginSecurity.description")}</p>
      {state.cliLocked ? <p className="settings-message">{t("pluginSecurity.cliLocked")}</p> : null}
      {loading ? <p role="status">{t("common.loading")}</p> : null}
      {error ? (
        <>
          <PluginError message={error} />
          <Button size="sm" disabled={loading || busy} onClick={() => void load(true)}>
            {t("common.retry")}
          </Button>
        </>
      ) : null}
      {(state.recoverySuggested || failure) && !recoveryDismissed ? (
        <div className="plugin-security__notice" role="status">
          <p>{t(failure ? "pluginSecurity.failureHint" : "pluginSecurity.recoveryHint")}</p>
          {failure ? <p className="settings-hint">{failure}</p> : null}
          <div className="settings-actions">
            <PluginRestrictedAction />
            <Button size="sm" variant="ghost" onClick={dismissRecovery}>
              {t("pluginSecurity.dismiss")}
            </Button>
          </div>
        </div>
      ) : null}
      <h4>{t("pluginSecurity.grants")}</h4>
      <p className="settings-hint">{t("pluginSecurity.nodeWarning")}</p>
      {Object.keys(state.grants).length ? (
        Object.entries(state.grants).map(([id, permissions]) => (
          <article className="plugin-security__grant" key={id}>
            <div>
              <strong>{plugins.find((plugin) => plugin.id === id)?.name ?? id}</strong>
              <PluginPermissionList permissions={permissions} />
            </div>
            <Button size="sm" disabled={busy || loading} onClick={() => void revoke(id)}>
              {t("pluginSecurity.revoke")}
            </Button>
          </article>
        ))
      ) : (
        <p className="settings-hint">{t("pluginSecurity.noGrants")}</p>
      )}
    </section>
  );
}
