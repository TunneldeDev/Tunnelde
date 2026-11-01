import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppInfo,
  Group,
  Host,
  HostInput,
  HostKeyInfo,
  HistoryEntry,
  HostsSnapshot,
  InstalledKey,
  KnownHostEntry,
  Listing,
  RemoteProcess,
  PluginInfo,
  PluginSecurityState,
  PluginConfig,
  MarketSource,
  MarketCatalogue,
  PluginDownload,
  NodeRuntimeInfo,
  RemoteStats,
  TextFile,
  Settings,
  SshConnectRequest,
  SshDataPayload,
  SshClosedPayload,
  SshSession,
  SettingsPatch,
  SystemStats,
  TabRecord,
  TransferEvent,
  UpdateState,
} from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  clipboardReadText: () => invoke<string>("clipboard_read_text"),
  clipboardWriteText: (text: string) => invoke<void>("clipboard_write_text", { text }),
  settings: () => invoke<Settings>("settings_get"),
  updateSettings: (patch: SettingsPatch) => invoke<Settings>("settings_update", { patch }),
  resetSettings: () => invoke<Settings>("settings_reset"),
  setLocale: (locale: string) => invoke<void>("set_locale", { locale }),

  hostsSnapshot: () => invoke<HostsSnapshot>("hosts_snapshot"),
  createHost: (input: HostInput) => invoke<Host>("host_create", { input }),
  updateHost: (id: string, input: HostInput) => invoke<Host>("host_update", { id, input }),
  deleteHost: (id: string) => invoke<void>("host_delete", { id }),
  markHostUsed: (id: string) => invoke<void>("host_mark_used", { id }),
  hostsReorder: (ids: string[]) => invoke<void>("hosts_reorder", { ids }),

  createGroup: (input: { name: string; parentId?: string | null }) =>
    invoke<Group>("group_create", { input }),
  updateGroup: (id: string, input: { name: string; parentId?: string | null }) =>
    invoke<Group>("group_update", { id, input }),
  deleteGroup: (id: string) => invoke<void>("group_delete", { id }),

  tabs: () => invoke<TabRecord[]>("tabs_snapshot"),
  saveTabs: (tabs: TabRecord[]) => invoke<void>("tabs_save", { tabs }),

  systemStats: () => invoke<SystemStats>("system_stats"),

  updateState: () => invoke<UpdateState>("update_state"),
  checkUpdates: (force = true) => invoke<UpdateState>("update_check", { force }),
  installUpdate: () => invoke<UpdateState>("update_install"),
  openReleasePage: () => invoke<void>("open_release_page"),

  openDataDir: () => invoke<void>("app_open_data_dir"),
  openLogDir: () => invoke<void>("open_log_dir"),
  openLocalPath: (path: string) => invoke<void>("open_local_path", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  sshProbe: (hostId: string) => invoke<HostKeyInfo>("ssh_probe", { hostId }),
  sshTrust: (hostId: string) => invoke<HostKeyInfo>("ssh_trust", { hostId }),
  sshConnect: (request: SshConnectRequest) => invoke<SshSession>("ssh_connect", { request }),
  sshAttach: (sessionId: string) => invoke<void>("ssh_attach", { sessionId }),
  sshWrite: (sessionId: string, data: string) => invoke<void>("ssh_write", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),
  sshInstallKey: (hostId: string, password: string | null) =>
    invoke<InstalledKey>("ssh_install_key", { hostId, password }),
  sshSessions: () => invoke<SshSession[]>("ssh_sessions"),

  knownHostsList: () => invoke<KnownHostEntry[]>("known_hosts_list"),
  knownHostsForget: (host: string, port: number) =>
    invoke<boolean>("known_hosts_forget", { host, port }),

  historyRecord: (hostId: string, command: string) =>
    invoke<HistoryEntry | null>("history_record", { hostId, command }),
  historyList: (hostId: string, limit?: number) =>
    invoke<HistoryEntry[]>("history_list", { hostId, limit: limit ?? null }),
  historyDelete: (id: number) => invoke<void>("history_delete", { id }),
  historyClear: (hostId: string) => invoke<void>("history_clear", { hostId }),

  pluginsList: () => invoke<PluginInfo[]>("plugins_list"),
  pluginSecurityState: () => invoke<PluginSecurityState>("plugin_security_state"),
  pluginSetRestricted: (enabled: boolean) =>
    invoke<PluginSecurityState>("plugin_set_restricted", { enabled }),
  pluginSetPermissions: (
    id: string,
    permissions: string[] | null,
    expectedFingerprint: string | null,
  ) => invoke<void>("plugin_set_permissions", { id, permissions, expectedFingerprint }),
  pluginStart: (id: string) => invoke<PluginInfo>("plugin_start", { id }),
  pluginStop: (id: string) => invoke<PluginInfo>("plugin_stop", { id }),
  pluginInstall: (path: string) => invoke<PluginInfo>("plugin_install", { path }),
  pluginInspect: (path: string) =>
    invoke<
      Pick<
        PluginInfo,
        "id" | "name" | "version" | "permissions" | "apiVersion" | "runtime" | "themes"
      >
    >("plugin_inspect", { path }),
  pluginPickFolder: () => invoke<string | null>("plugin_pick_folder"),
  pluginPickArchive: () => invoke<string | null>("plugin_pick_archive"),
  pluginUninstall: (id: string) => invoke<void>("plugin_uninstall", { id }),
  pluginReload: () => invoke<PluginInfo[]>("plugin_reload"),
  pluginRenderView: (id: string, view: string, locale?: string) =>
    invoke<unknown>("plugin_render_view", { id, view, locale: locale ?? null }),
  pluginRun: (id: string, command: string, input?: Record<string, unknown>) =>
    invoke<unknown>("plugin_run", { id, command, input: input ?? null }),
  pluginOpenDir: () => invoke<void>("plugin_open_dir"),
  marketplaceInstall: (id: string, sha256: string, data: string) =>
    invoke<PluginInfo>("marketplace_install", { id, sha256, data }),
  pluginConfig: () => invoke<PluginConfig>("plugin_config"),
  pluginSourcesSave: (sources: MarketSource[]) =>
    invoke<PluginConfig>("plugin_sources_save", { sources }),
  pluginSourceTest: (url: string) => invoke<number>("plugin_source_test", { url }),
  marketplaceCatalogue: (sourceId: string, refresh = false) =>
    invoke<MarketCatalogue>("marketplace_catalogue", { sourceId, refresh }),
  marketplaceDownload: (
    sourceId: string,
    id: string,
    version: string,
    sha256: string,
    taskId: string,
    update: boolean,
  ) =>
    invoke<PluginInfo>("marketplace_download", { sourceId, id, version, sha256, taskId, update }),
  downloadCancel: (taskId: string) => invoke<boolean>("plugin_download_cancel", { taskId }),
  nodeDetect: () => invoke<NodeRuntimeInfo>("node_detect"),
  nodeInstall: (taskId: string) => invoke<NodeRuntimeInfo>("node_install", { taskId }),
  nodePick: () => invoke<string | null>("node_pick"),
  nodeSetPath: (path: string | null) => invoke<NodeRuntimeInfo>("node_set_path", { path }),
  nodeAllowSystem: (allowed: boolean) => invoke<NodeRuntimeInfo>("node_allow_system", { allowed }),

  remoteStats: (sessionId: string) => invoke<RemoteStats>("remote_stats", { sessionId }),
  remoteProcesses: (sessionId: string) =>
    invoke<RemoteProcess[]>("remote_processes", { sessionId }),
  remoteKill: (sessionId: string, pid: number) => invoke<void>("remote_kill", { sessionId, pid }),

  sftpList: (sessionId: string, path?: string | null) =>
    invoke<Listing>("sftp_list", { sessionId, path: path ?? null }),
  localList: (path?: string | null) => invoke<Listing>("local_list", { path: path ?? null }),
  localHome: () => invoke<string>("local_home"),
  sftpMkdir: (sessionId: string, path: string) => invoke<void>("sftp_mkdir", { sessionId, path }),
  sftpRename: (sessionId: string, from: string, to: string, overwrite = false) =>
    invoke<void>("sftp_rename", { sessionId, from, to, overwrite }),
  sftpDelete: (sessionId: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_delete", { sessionId, path, isDir }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localCreateFile: (path: string) => invoke<void>("local_create_file", { path }),
  localRename: (from: string, to: string, overwrite = false) =>
    invoke<void>("local_rename", { from, to, overwrite }),
  localDelete: (path: string, isDir: boolean) => invoke<void>("local_delete", { path, isDir }),
  sftpCreateFile: (sessionId: string, path: string) =>
    invoke<void>("sftp_create_file", { sessionId, path }),
  sftpCopy: (sessionId: string, from: string, to: string, overwrite = false) =>
    invoke<void>("sftp_copy", { sessionId, from, to, overwrite }),
  localCopy: (from: string, to: string, overwrite = false) =>
    invoke<void>("local_copy", { from, to, overwrite }),

  sftpReadText: (sessionId: string, path: string) =>
    invoke<TextFile>("sftp_read_text", { sessionId, path }),
  sftpWriteText: (sessionId: string, path: string, content: string) =>
    invoke<void>("sftp_write_text", { sessionId, path, content }),

  fsTransfer: (
    fromSession: string | null,
    fromPath: string,
    toSession: string | null,
    toPath: string,
    removeSource: boolean,
    overwrite = false,
  ) =>
    invoke<string>("fs_transfer", {
      fromSession,
      fromPath,
      toSession,
      toPath,
      removeSource,
      overwrite,
    }),
  transferCancel: (transferId: string) => invoke<void>("transfer_cancel", { transferId }),

  credentialSave: (hostId: string, password: string) =>
    invoke<void>("credential_save", { hostId, password }),
  credentialForget: (hostId: string) => invoke<void>("credential_forget", { hostId }),
  credentialStatus: (hostId: string) => invoke<boolean>("credential_status", { hostId }),

  importCss: () => invoke<string | null>("user_css_import"),
  exportCss: (css: string) => invoke<string | null>("user_css_export", { css }),

  keyImport: (content: string) => invoke<string>("key_import", { content }),
  keyPick: () => invoke<string | null>("key_pick"),
};

export const events = {
  onPluginSecurity: (handler: (payload: PluginSecurityState) => void): Promise<UnlistenFn> =>
    listen<PluginSecurityState>("plugin:security-changed", (event) => handler(event.payload)),
  onPluginDownload: (handler: (payload: PluginDownload) => void): Promise<UnlistenFn> =>
    listen<PluginDownload>("plugins://download", (event) => handler(event.payload)),
  onPluginConfig: (handler: (payload: PluginConfig) => void): Promise<UnlistenFn> =>
    listen<PluginConfig>("plugins://config", (event) => handler(event.payload)),
  onSettingsChanged: (handler: (settings: Settings) => void): Promise<UnlistenFn> =>
    listen<Settings>("settings://changed", (event) => handler(event.payload)),
  onUpdateState: (handler: (state: UpdateState) => void): Promise<UnlistenFn> =>
    listen<UpdateState>("update://state", (event) => handler(event.payload)),
  onNavigate: (handler: (page: string) => void): Promise<UnlistenFn> =>
    listen<string>("ui://navigate", (event) => handler(event.payload)),
  onSshData: (handler: (payload: SshDataPayload) => void): Promise<UnlistenFn> =>
    listen<SshDataPayload>("ssh://data", (event) => handler(event.payload)),
  onSshClosed: (handler: (payload: SshClosedPayload) => void): Promise<UnlistenFn> =>
    listen<SshClosedPayload>("ssh://closed", (event) => handler(event.payload)),
  onPluginState: (handler: (payload: PluginInfo) => void): Promise<UnlistenFn> =>
    listen<PluginInfo>("plugin://state", (event) => handler(event.payload)),
  onTransfer: (handler: (payload: TransferEvent) => void): Promise<UnlistenFn> =>
    listen<TransferEvent>("sftp://transfer", (event) => handler(event.payload)),
};
