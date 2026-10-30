// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppInfo,
  Group,
  Host,
  HostInput,
  HostKeyInfo,
  HostsSnapshot,
  Settings,
  SshConnectRequest,
  SshDataPayload,
  SshClosedPayload,
  SshSession,
  SettingsPatch,
  SystemStats,
  TabRecord,
  UpdateState,
} from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  settings: () => invoke<Settings>("settings_get"),
  updateSettings: (patch: SettingsPatch) => invoke<Settings>("settings_update", { patch }),
  resetSettings: () => invoke<Settings>("settings_reset"),
  setLocale: (locale: string) => invoke<void>("set_locale", { locale }),

  hostsSnapshot: () => invoke<HostsSnapshot>("hosts_snapshot"),
  createHost: (input: HostInput) => invoke<Host>("host_create", { input }),
  updateHost: (id: string, input: HostInput) => invoke<Host>("host_update", { id, input }),
  deleteHost: (id: string) => invoke<void>("host_delete", { id }),
  markHostUsed: (id: string) => invoke<void>("host_mark_used", { id }),

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

  openLogDir: () => invoke<void>("open_log_dir"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  sshProbe: (hostId: string) => invoke<HostKeyInfo>("ssh_probe", { hostId }),
  sshTrust: (hostId: string) => invoke<HostKeyInfo>("ssh_trust", { hostId }),
  sshConnect: (request: SshConnectRequest) => invoke<SshSession>("ssh_connect", { request }),
  sshWrite: (sessionId: string, data: string) => invoke<void>("ssh_write", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),
  sshSessions: () => invoke<SshSession[]>("ssh_sessions"),

  credentialSave: (hostId: string, password: string) =>
    invoke<void>("credential_save", { hostId, password }),
  credentialForget: (hostId: string) => invoke<void>("credential_forget", { hostId }),
  credentialStatus: (hostId: string) => invoke<boolean>("credential_status", { hostId }),

  importCss: () => invoke<string | null>("user_css_import"),
  exportCss: (css: string) => invoke<string | null>("user_css_export", { css }),
};

export const events = {
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
};
