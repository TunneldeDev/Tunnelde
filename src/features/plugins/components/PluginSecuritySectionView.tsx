import { useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { SwitchRow } from "@/components/ui/form/Switch";
import type { PluginSecurityState } from "@/lib/api/types";
import type { SettingsControlState } from "@/features/settings/components/controlState";
import { PluginPermissionList } from "./PluginPermissionList";
import { PluginErrorView } from "./PluginErrorView";
export interface PluginSecurityData {
  state: PluginSecurityState;
  ready: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  failure: string | null;
  recoveryDismissed: boolean;
  plugins: { id: string; name: string }[];
}
export interface PluginSecurityServices {
  useData(): PluginSecurityData;
  useViewState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
  load(force?: boolean): Promise<void>;
  setRestricted(enabled: boolean): Promise<boolean>;
  revoke(id: string): Promise<boolean>;
  dismissRecovery(): void;
  copyError(message: string): void;
}
const PERMISSION_GROUPS = {
  communication: ["bus"],
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
  open,
  onOpen,
}: {
  id: string;
  name: string;
  permissions: string[];
  disabled: boolean;
  revoke: (id: string) => Promise<unknown>;
  open: boolean;
  onOpen(open: boolean): void;
}) {
  const { t } = useTranslation();
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
      <details open={open} onToggle={(event) => onOpen(event.currentTarget.open)}>
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

export function PluginSecuritySectionView({ services }: { services: PluginSecurityServices }) {
  const { t } = useTranslation();
  const { state, ready, loading, busy, error, failure, recoveryDismissed, plugins } =
    services.useData();
  const { load, setRestricted, revoke, dismissRecovery, useViewState, useBusyGuard } = services;
  const [approvalsOpen, setApprovalsOpen] = useViewState("settings:security:approvals", false);
  const [expandedGrants, setExpandedGrants] = useViewState<Record<string, boolean>>(
    "settings:security:grants",
    {},
  );
  useBusyGuard(busy || loading);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="settings-subsection plugin-security" aria-label={t("pluginSecurity.title")}>
      <h3 className="settings-subtitle">{t("pluginSecurity.title")}</h3>
      <SwitchRow
        label={t("pluginSecurity.restricted")}
        hint={t("pluginSecurity.description")}
        checked={state.restricted}
        disabled={!ready || loading || busy || state.cliLocked}
        onChange={(enabled) => void setRestricted(enabled)}
      />
      {state.cliLocked ? <p className="settings-message">{t("pluginSecurity.cliLocked")}</p> : null}
      {loading ? <p role="status">{t("common.loading")}</p> : null}
      {error ? (
        <>
          <PluginErrorView message={error} onCopy={services.copyError} />
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
            {!state.restricted ? (
              <Button size="sm" disabled={busy} onClick={() => void setRestricted(true)}>
                {t("pluginSecurity.enterRestricted")}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={dismissRecovery}>
              {t("pluginSecurity.dismiss")}
            </Button>
          </div>
        </div>
      ) : null}
      <details
        className="plugin-security__approvals"
        open={approvalsOpen}
        onToggle={(event) => setApprovalsOpen(event.currentTarget.open)}
      >
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
                open={expandedGrants[id] === true}
                onOpen={(opened) =>
                  setExpandedGrants((previous) => ({ ...previous, [id]: opened }))
                }
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
