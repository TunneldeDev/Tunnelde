import { useEffect, useState } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Switch } from "@/components/ui/form/Field";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { PluginPermissionList } from "./PluginPermissionGate";
import { PluginError } from "./PluginError";

const PERMISSION_GROUPS = {
  execution: ["process", "network", "secrets"],
  remote: ["hosts", "sessions", "ssh", "sftp", "monitor", "history", "mounts", "forwards"],
  files: ["fs"],
  workspace: ["workspace", "clipboard", "backgroundTasks"],
  application: ["app", "settings", "log"],
  other: [],
} as const;

function ApprovedPlugin({
  id,
  name,
  permissions,
  disabled,
  revoke,
}: {
  id: string;
  name: string;
  permissions: string[];
  disabled: boolean;
  revoke: (id: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groups = (Object.keys(PERMISSION_GROUPS) as Array<keyof typeof PERMISSION_GROUPS>)
    .map((group) => ({
      group,
      permissions: permissions.filter((permission) => {
        const prefix = permission.split(".")[0] ?? "";
        return group === "other"
          ? !Object.values(PERMISSION_GROUPS).some((values) =>
              (values as readonly string[]).includes(prefix),
            )
          : (PERMISSION_GROUPS[group] as readonly string[]).includes(prefix);
      }),
    }))
    .filter((group) => group.permissions.length);
  return (
    <article className="plugin-security__grant">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          <span className="plugin-security__identity">
            <strong>{name}</strong>
            <small>{id}</small>
          </span>
          <span className="plugin-security__count">
            {t("pluginSecurity.permissionCount", { count: permissions.length })}
          </span>
        </summary>
        {open ? (
          <div className="plugin-security__groups">
            {groups.length ? (
              groups.map((group) => (
                <details key={group.group} className="plugin-security__group">
                  <summary>
                    <ChevronRight size={12} aria-hidden="true" />
                    <span>{t(`pluginSecurity.permissionGroup.${group.group}`)}</span>
                    <span className="plugin-security__count">{group.permissions.length}</span>
                  </summary>
                  <PluginPermissionList permissions={group.permissions} />
                </details>
              ))
            ) : (
              <PluginPermissionList permissions={[]} />
            )}
          </div>
        ) : null}
      </details>
      <Button size="sm" disabled={disabled} onClick={() => void revoke(id)}>
        {t("pluginSecurity.revoke")}
      </Button>
    </article>
  );
}

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
      <details className="plugin-security__approvals">
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          <strong>{t("pluginSecurity.grants")}</strong>
          <span className="plugin-security__count">{Object.keys(state.grants).length}</span>
        </summary>
        <p className="settings-hint">{t("pluginSecurity.nodeWarning")}</p>
        <div className="plugin-security__grant-list">
          {Object.keys(state.grants).length ? (
            Object.entries(state.grants).map(([id, permissions]) => (
              <ApprovedPlugin
                key={id}
                id={id}
                name={plugins.find((plugin) => plugin.id === id)?.name ?? id}
                permissions={permissions}
                disabled={busy || loading}
                revoke={revoke}
              />
            ))
          ) : (
            <p className="settings-hint">{t("pluginSecurity.noGrants")}</p>
          )}
        </div>
      </details>
    </section>
  );
}
