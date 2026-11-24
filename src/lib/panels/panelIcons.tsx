import {
  Activity,
  Blocks,
  Download,
  FileText,
  FolderTree,
  History,
  Info,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal,
} from "lucide-react";

/** Stable native panel IDs map to one semantic icon. Keep this pure so a
 * detached tab cannot depend on a feature store that exists only in main. */
export function panelIconKind(panelId: string) {
  if (panelId.startsWith("settings-view:")) return "settings";
  if (panelId.startsWith("editor-view:")) return "editor";
  if (panelId.startsWith("host-view:")) return "host";
  if (panelId.startsWith("files:") || panelId.startsWith("sftp:")) return "files";
  if (panelId.startsWith("terminal:")) return "terminal";
  if (panelId.startsWith("plugin:")) return "plugin";
  switch (panelId) {
    case "plugins":
      return "plugins";
    case "hosts":
      return "hosts";
    case "knownHosts":
      return "knownHosts";
    case "tasks":
      return "tasks";
    case "forwarding":
      return "forwarding";
    case "connections":
      return "connections";
    default:
      return "other";
  }
}

export function panelIcon(panelId: string) {
  switch (panelIconKind(panelId)) {
    case "settings":
      return <SettingsIcon size={13} data-panel-icon="settings" />;
    case "editor":
      return <FileText size={13} data-panel-icon="editor" />;
    case "host":
    case "hosts":
      return <Server size={13} data-panel-icon="host" />;
    case "files":
      return <FolderTree size={13} data-panel-icon="files" />;
    case "terminal":
      return <Terminal size={13} data-panel-icon="terminal" />;
    case "plugins":
    case "plugin":
      return <Blocks size={13} data-panel-icon="plugin" />;
    case "knownHosts":
      return <ShieldCheck size={13} data-panel-icon="knownHosts" />;
    case "tasks":
      return <Activity size={13} data-panel-icon="tasks" />;
    case "forwarding":
      return <Download size={13} data-panel-icon="forwarding" />;
    case "connections":
      return <History size={13} data-panel-icon="connections" />;
    default:
      return <Info size={13} data-panel-icon="other" />;
  }
}
