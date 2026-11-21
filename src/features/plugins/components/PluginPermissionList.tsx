import { useTranslation } from "react-i18next";

export function PluginPermissionList({ permissions }: { permissions: string[] }) {
  const { t } = useTranslation();
  const descriptions = {
    "ui.trusted": "pluginSecurity.permission.trustedUi",
    log: "pluginSecurity.permission.log",
    "logs.read": "pluginSecurity.permission.logsRead",
    "app.read": "pluginSecurity.permission.appRead",
    "settings.read": "pluginSecurity.permission.settingsRead",
    "settings.write": "pluginSecurity.permission.settingsWrite",
    "storage.locations.read": "pluginSecurity.permission.storageLocationsRead",
    "storage.locations.write": "pluginSecurity.permission.storageLocationsWrite",
    "storage.recovery.read": "pluginSecurity.permission.storageRecoveryRead",
    "storage.recovery.write": "pluginSecurity.permission.storageRecoveryWrite",
    "hosts.read": "pluginSecurity.permission.hostsRead",
    "hosts.write": "pluginSecurity.permission.hostsWrite",
    "hosts.sshConfig.read": "pluginSecurity.permission.hostsSshConfigRead",
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
    "editor.read": "pluginSecurity.permission.editorRead",
    "fileBrowser.read": "pluginSecurity.permission.fileBrowserRead",
    "fileBrowser.write": "pluginSecurity.permission.fileBrowserWrite",
    "filePreview.read": "pluginSecurity.permission.filePreviewRead",
    "filePreview.write": "pluginSecurity.permission.filePreviewWrite",
    "editor.write": "pluginSecurity.permission.editorWrite",
    "app.openExternal": "pluginSecurity.permission.openExternal",
    network: "pluginSecurity.permission.network",
    "process.exec": "pluginSecurity.permission.processExec",
    secrets: "pluginSecurity.permission.secrets",
    "mounts.read": "pluginSecurity.permission.mountsRead",
    "mounts.write": "pluginSecurity.permission.mountsWrite",
    "mounts.hostDetails": "pluginSecurity.permission.mountsHostDetails",
    "bus.communicate": "pluginSecurity.permission.busCommunicate",
    "backgroundTasks.read": "pluginSecurity.permission.backgroundTasksRead",
    "backgroundTasks.write": "pluginSecurity.permission.backgroundTasksWrite",
    "forwards.read": "pluginSecurity.permission.forwardsRead",
    "forwards.write": "pluginSecurity.permission.forwardsWrite",
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
