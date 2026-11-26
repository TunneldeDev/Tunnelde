/** Private native UI commands. No credentials, raw host inputs or arbitrary IPC. */
export interface HostPanelTarget {
  id: string;
  revision: string;
}
export type HostPanelCommand =
  | {
      operation:
        | "activate"
        | "connect"
        | "open"
        | "edit"
        | "delete"
        | "favorite"
        | "duplicate"
        | "saveCopy"
        | "export"
        | "copySsh"
        | "copyAddress"
        | "monitor"
        | "sftp"
        | "installKey";
      host: HostPanelTarget;
    }
  | {
      operation: "move";
      host: HostPanelTarget;
      target: HostPanelTarget;
      position: "before" | "after";
    }
  | {
      operation: "moveToGroup";
      host: HostPanelTarget;
      group: HostPanelTarget | null;
      favorite: boolean;
    }
  | { operation: "newHost"; group: HostPanelTarget | null }
  | { operation: "newGroup" | "importSsh" | "import" | "exportAll" }
  | { operation: "editGroup" | "deleteGroup"; group: HostPanelTarget }
  | {
      operation: "plugin";
      host: HostPanelTarget;
      pluginId: string;
      command: string;
      fingerprint: string | null;
    }
  | { operation: "view"; view: "tree" | "table" }
  | { operation: "column"; key: string; command: "toggle" | "sort" }
  | { operation: "resizeColumn"; key: string; width: number }
  | { operation: "moveColumn"; from: string; to: string }
  | { operation: "resetColumns" };
export interface HostPanelWindowAction {
  kind: "hosts";
  command: HostPanelCommand;
}
