// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

export type Language = "system" | "zh-CN" | "en-US";
export type ThemeMode = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";
export type Accent = "blue" | "cyan" | "green" | "orange" | "violet";
export type MonoFont = "fira-code" | "jetbrains-mono" | "plex-mono" | "system";

export interface Settings {
  language: Language;
  theme: ThemeMode;
  accent: Accent | string;
  density: Density;
  uiFontSize: number;
  monoFontSize: number;
  monoFont: MonoFont;
  sidebarWidth: number;
  rightPanel: boolean;
  rightPanelWidth: number;
  userCss: string;
  autoCheckUpdates: boolean;
  skippedVersion: string | null;
  lastUpdateCheck: number | null;
  closeToTray: boolean;
  nativeMenu: boolean;
  preloadDirs: boolean;
  preloadCount: number;
  customTitleBar: boolean;
}

export type SettingsPatch = Partial<Settings>;

export interface SettingsSchema {
  languages: Language[];
  themes: ThemeMode[];
  accents: string[];
  densities: Density[];
}

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
  debug: boolean;
  dataDir: string;
  logDir: string;
  schema: SettingsSchema;
}

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export type AuthMethod = "password" | "key" | "agent" | "keyboardInteractive";

export interface Host {
  id: string;
  groupId: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath: string | null;
  favorite: boolean;
  color: string | null;
  tags: string[];
  note: string | null;
  sortOrder: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface HostInput {
  name: string;
  groupId?: string | null;
  host: string;
  port?: number;
  username?: string;
  authMethod?: AuthMethod;
  keyPath?: string | null;
  favorite?: boolean;
  color?: string | null;
  tags?: string[];
  note?: string | null;
}

export interface HostsSnapshot {
  groups: Group[];
  hosts: Host[];
}

export type TabKind =
  | "welcome"
  | "host"
  | "settings"
  | "about"
  | "updates"
  | "terminal"
  | "sftp"
  | "editor"
  | "history"
  | "monitor"
  | "pluginView";

export interface TabRecord {
  id: string;
  kind: TabKind;
  title: string;
  hostId: string | null;
  sortOrder: number;
  pinned: boolean;
  state: string | null;
}

export interface DiskInfo {
  mount: string;
  total: number;
  available: number;
}

export interface SystemStats {
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  swapUsed: number;
  swapTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptime: number;
  loadAverage: [number, number, number];
  processCount: number;
  appMemory: number;
  appProcesses: number;
  disks: DiskInfo[];
  sampledAt: number;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "unsupported"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  version: string | null;
  notes: string | null;
  publishedAt: number | null;
  progress: number | null;
  contentLength: number | null;
  error: string | null;
  lastChecked: number | null;
  available: boolean;
  autoInstall: boolean;
  unsupportedReason: string | null;
  downloadUrl: string | null;
  skipped: boolean;
}

export interface IpcError {
  code: string;
  message: string;
}

export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as IpcError).message === "string"
  );
}

export type HostKeyStatus = "known" | "unknown" | "changed";

export interface HostKeyInfo {
  fingerprint: string;
  algorithm: string;
  status: HostKeyStatus;
  knownFingerprint: string | null;
}

export interface InstalledKey {
  publicKey: string;
  keyPath: string;
}

export interface SshSession {
  id: string;
  hostId: string;
  title: string;
  address: string;
  cols: number;
  rows: number;
  connectedAt: number;
}

export interface SshConnectRequest {
  hostId: string;
  password?: string | null;
  passphrase?: string | null;
  cols?: number;
  rows?: number;
}

export interface SshDataPayload {
  sessionId: string;
  data: string;
}

export interface SshClosedPayload {
  sessionId: string;
  reason: string;
}
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

export interface Listing {
  path: string;
  entries: FileEntry[];
}

/** A file panel can show this computer or any connected server. */
export type FsSource = { kind: "local" } | { kind: "remote"; sessionId: string };

export type TransferDirection = "transfer";
export type TransferStatus = "running" | "done" | "failed" | "cancelled";

export interface TransferEvent {
  id: string;
  direction: TransferDirection;
  name: string;
  transferred: number;
  total: number;
  status: TransferStatus;
  error: string | null;
}
export interface RemoteProcess {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  rss: number;
}

export interface RemoteStats {
  cpuPercent: number;
  cpuCount: number;
  memoryUsed: number;
  memoryTotal: number;
  swapUsed: number;
  swapTotal: number;
  diskUsed: number;
  diskTotal: number;
  load: [number, number, number];
  uptime: number;
  netRxRate: number;
  netTxRate: number;
  processes: RemoteProcess[];
  sampledAt: number;
}
export interface TextFile {
  content: string;
  size: number;
}
export type PluginStatus = "stopped" | "running" | "failed";

export interface PluginCommand {
  id: string;
  title: string;
}

export interface PluginView {
  id: string;
  title: string;
}

export interface MarketEntry {
  id: string;
  name: string;
  version: string;
  description: string | null;
  url: string;
  sha256: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description: string | null;
  commands: PluginCommand[];
  views: PluginView[];
  permissions: string[];
  status: PluginStatus;
  error: string | null;
  path: string;
}
export interface HistoryEntry {
  id: number;
  hostId: string;
  command: string;
  executedAt: number;
}
export interface KnownHostEntry {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  updatedAt: number;
}