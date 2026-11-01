import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { PluginError } from "./PluginError";
import { useNodeRuntimeGateOpen } from "./NodeRuntimeSection";
import { useDialogs } from "@/store/dialogs";
import { useNavigation } from "@/store/navigation";

export function PluginPermissionList({ permissions }: { permissions: string[] }) {
  const { t } = useTranslation();
  const descriptions = {
    log: "pluginSecurity.permission.log",
    "app.read": "pluginSecurity.permission.appRead",
    "settings.read": "pluginSecurity.permission.settingsRead",
    "settings.write": "pluginSecurity.permission.settingsWrite",
    "hosts.read": "pluginSecurity.permission.hostsRead",
    "hosts.write": "pluginSecurity.permission.hostsWrite",
    "sessions.read": "pluginSecurity.permission.sessionsRead",
    "clipboard.read": "pluginSecurity.permission.clipboardRead",
    "clipboard.write": "pluginSecurity.permission.clipboardWrite",
    "ssh.exec": "pluginSecurity.permission.sshExec",
    "fs.read": "pluginSecurity.permission.fsRead",
    "fs.write": "pluginSecurity.permission.fsWrite",
    "sftp.read": "pluginSecurity.permission.sftpRead",
    "sftp.write": "pluginSecurity.permission.sftpWrite",
    "monitor.read": "pluginSecurity.permission.monitorRead",
    "monitor.write": "pluginSecurity.permission.monitorWrite",
    "history.read": "pluginSecurity.permission.historyRead",
    "history.write": "pluginSecurity.permission.historyWrite",
    "workspace.read": "pluginSecurity.permission.workspaceRead",
    "workspace.write": "pluginSecurity.permission.workspaceWrite",
    "app.openExternal": "pluginSecurity.permission.openExternal",
    network: "pluginSecurity.permission.network",
  } as const;
  return permissions.length ? (
    <ul className="plugin-permissions">
      {permissions.map((permission) => (
        <li key={permission}>
          <code>{permission}</code>
          <span>
            {t(
              descriptions[permission as keyof typeof descriptions] ??
                "pluginSecurity.permission.other",
            )}
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="settings-hint">{t("pluginSecurity.noPermissions")}</p>
  );
}

export function PluginPermissionGate() {
  const { t } = useTranslation();
  const { prompts, busy, error, approve, deny, setRestricted } = usePluginSecurity();
  const nodeOpen = useNodeRuntimeGateOpen();
  const dialogOpen = useDialogs((value) => value.dialog.kind !== "none");
  const plugin = prompts[0];
  if (!plugin || nodeOpen || dialogOpen) return null;
  return (
    <Dialog
      open
      title={t("pluginSecurity.allowTitle", { name: plugin.name })}
      closeLabel={t("common.close")}
      onClose={() => deny(plugin.id)}
      dismissible={!busy}
      width={600}
      footer={
        <>
          <Button disabled={busy} onClick={() => void setRestricted(true)}>
            {t("pluginSecurity.enterRestricted")}
          </Button>
          <Button disabled={busy} onClick={() => deny(plugin.id)}>
            {t("pluginSecurity.deny")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void approve(plugin.id)}>
            {t("pluginSecurity.allow")}
          </Button>
        </>
      }
    >
      <p>{t("pluginSecurity.allowBody", { name: plugin.name, version: plugin.version })}</p>
      <p className="settings-hint">
        {t("pluginSecurity.publisher", {
          name: plugin.author?.trim() || t("market.unknownAuthor"),
        })}
        <br />
        {plugin.sourceUrl ?? plugin.path}
      </p>
      <PluginPermissionList permissions={plugin.permissions} />
      <p className="settings-hint">
        {t(plugin.runtime === "wasm" ? "pluginSecurity.wasmWarning" : "pluginSecurity.nodeWarning")}
      </p>
      <p className="settings-hint">{t("pluginSecurity.updateWarning")}</p>
      {error ? <PluginError message={error} /> : null}
    </Dialog>
  );
}

export function PluginRecoveryPrompt() {
  const { t } = useTranslation();
  const { recoveryPrompt, prompts, state, failure, busy, error, setRestricted, dismissRecovery } =
    usePluginSecurity();
  const nodeOpen = useNodeRuntimeGateOpen();
  const dialogOpen = useDialogs((value) => value.dialog.kind !== "none");
  if (!recoveryPrompt || prompts.length || nodeOpen || dialogOpen) return null;
  const protectedStartup = recoveryPrompt === "startup" && state.restricted;
  return (
    <Dialog
      open
      title={t("pluginSecurity.recoveryTitle")}
      closeLabel={t("common.close")}
      onClose={dismissRecovery}
      dismissible={!busy}
      width={560}
      footer={
        <>
          <Button disabled={busy} onClick={dismissRecovery}>
            {t(protectedStartup ? "pluginSecurity.keepRestricted" : "pluginSecurity.notNow")}
          </Button>
          {protectedStartup ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                dismissRecovery();
                useNavigation.getState().showSidebar("plugins");
              }}
            >
              {t("pluginSecurity.viewPlugins")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void setRestricted(true).then((ok) => {
                  if (ok) dismissRecovery();
                });
              }}
            >
              {t("pluginSecurity.enterRestricted")}
            </Button>
          )}
        </>
      }
    >
      <p>
        {t(
          protectedStartup
            ? "pluginSecurity.protectedStartup"
            : recoveryPrompt === "startup"
              ? "pluginSecurity.recoveryHint"
              : "pluginSecurity.failureHint",
        )}
      </p>
      {failure ? <p className="settings-hint">{failure}</p> : null}
      {error ? <PluginError message={error} /> : null}
    </Dialog>
  );
}
