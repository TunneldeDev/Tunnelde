import type { NetworkSettings } from "./network";
export type Language = "system" | "zh-CN" | "en-US";
export type ThemeMode = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";
export type Accent = "blue" | "cyan" | "green" | "orange" | "violet";
export type MonoFont = "fira-code" | "jetbrains-mono" | "plex-mono" | "system";
export type TitleBarStyle = "system" | "compact";
export type MotionPreference = "system" | "reduced" | "full";
export type HostActivation = "terminal" | "details" | "edit";
export type TerminalCursorStyle = "block" | "bar" | "underline";
export type TerminalInactiveCursorStyle = TerminalCursorStyle | "outline" | "none";
export type TerminalRightClick = "menu" | "copyPaste" | "paste";
export type TerminalRenderer = "auto" | "dom";
export type FileSortBy = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";
export type ColorRegion =
  | "background"
  | "activityBar"
  | "sidebar"
  | "titleBar"
  | "tabBar"
  | "editor"
  | "panel"
  | "statusBar"
  | "terminalBackground"
  | "terminalForeground"
  | "terminalCursor";
export type ColorOverrides = Partial<Record<ColorRegion, string>>;

export interface Settings {
  network: NetworkSettings;
  keyboardShortcuts: Record<string, string[]>;
  language: Language;
  theme: ThemeMode;
  accent: Accent | string;
  colors: ColorOverrides;
  density: Density;
  uiFontSize: number;
  monoFontSize: number;
  monoFont: MonoFont;
  sidebarWidth: number;
  rightPanel: boolean;
  rightPanelWidth: number;
  userCss: string;
  autoCheckUpdates: boolean;
  updateChannel: "stable" | "beta" | "nightly";
  updateSource: "github" | "custom";
  updateSourceUrl: string;
  updateCheckInterval: "startup" | "daily" | "weekly";
  skippedVersion: string | null;
  lastUpdateCheck: number | null;
  closeToTray: boolean;
  releaseWebviewInTray: boolean;
  lightweightMode: boolean;
  showDockIconInBackground: boolean;
  titleBarStyle: TitleBarStyle;
  recordTerminalHistory: boolean;
  preloadDirs: boolean;
  preloadCount: number;
  motion: MotionPreference;
  showStatusBar: boolean;
  restoreWorkspace: boolean;
  hostActivation: HostActivation;
  hostDirectConnect: boolean;
  terminalScrollback: number;
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalInactiveCursorStyle: TerminalInactiveCursorStyle;
  terminalScrollSensitivity: number;
  terminalSmoothScrolling: boolean;
  terminalScrollOnInput: boolean;
  terminalCopyOnSelect: boolean;
  terminalRightClick: TerminalRightClick;
  terminalRenderer: TerminalRenderer;
  fileIconTheme: string;
  filesShowHidden: boolean;
  filesFoldersFirst: boolean;
  filesSortBy: FileSortBy;
  filesSortDirection: SortDirection;
  transferOptimization: boolean;
  transferConcurrency: number;
  transferChunkKib: number;
  transferRequests: number;
  transferUploadLimitKib: number;
  transferDownloadLimitKib: number;
  editorWordWrap: boolean;
  editorTabSize: number;
  editorSpellCheck: boolean;
  monitorIntervalMs: number;
}

export type SettingsPatch = Partial<Settings>;

export interface SettingsSchema {
  languages: Language[];
  themes: ThemeMode[];
  accents: string[];
  densities: Density[];
}

export interface AppInfo {
  defaultSettings: Settings;
  systemLanguages?: string[];
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
  | "sidebar"
  | "knownHosts"
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
  | "pluginView"
  | "pluginDetail";

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
  channel: Settings["updateChannel"];
  source: Settings["updateSource"];
  sourceUrl: string;
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
  hostId?: string;
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
  jumpCredentials?: Record<string, { password?: string; passphrase?: string }>;
  hostId: string;
  password?: string | null;
  passphrase?: string | null;
  cols?: number;
  rows?: number;
}

export interface SshDataPayload {
  sessionId: string;
  data: string;
  sequence: number;
}

export interface SshClosedPayload {
  sessionId: string;
  reason: string;
}
export interface FileEntry {
  isHidden: boolean;
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
export type TransferStatus =
  "running" | "done" | "failed" | "cancelled" | "paused" | "cleanupPending";

export interface TransferEvent {
  phase?: "queued" | "preparing" | "verifying" | "cleaning";
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
  diskReadRate: number | null;
  diskWriteRate: number | null;
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
  location?: "sidebar" | "workspace";
  kind?: "chat" | "blocks";
  icon?: string;
}

export interface PluginEvent {
  pluginId: string;
  generation: number;
  event: string;
  payload: unknown;
}

export interface MarketEntry {
  tags?: string[];
  id: string;
  name: string;
  version: string;
  description: string | null;
  url: string;
  sha256: string;
  author?: string | null;
  readme?: string | null;
  runtime?: "node" | "wasm" | "theme" | "declarative" | null;
  apiVersion?: number | null;
  engines?: Record<string, string>;
  sourceId?: string;
}

export interface MarketSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}
export interface PluginConfig {
  sources: MarketSource[];
  nodePath: string | null;
  nodeSystemAllowed: boolean;
}
export interface MarketCatalogue {
  source: MarketSource;
  entries: MarketEntry[];
  checkedAt: number;
  stale: boolean;
  error: string | null;
}
export interface PluginDownload {
  taskId: string;
  phase: string;
  received: number;
  total: number | null;
}
export interface NodeRuntimeInfo {
  path: string | null;
  version: string | null;
  source: "explicit" | "environment" | "path" | "registry" | "shell" | "managed" | null;
  compatible: boolean;
  minimumMajor: number;
  issue: string | null;
}

export interface PluginInfo {
  tags?: string[];
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
  fingerprint?: string;
  runtime?: "node" | "wasm" | "theme" | "declarative";
  themes?: PluginTheme[];
  fileIconThemes?: PluginFileIconTheme[];
  filePreviews?: PluginFilePreview[];
  author?: string | null;
  readme?: string | null;
  engines?: Record<string, string>;
  sourceId?: string | null;
  sourceUrl?: string | null;
}
export type FileIconSymbol =
  | "file"
  | "code"
  | "json"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "pdf"
  | "spreadsheet"
  | "terminal"
  | "settings"
  | "key"
  | "database"
  | "font"
  | "binary"
  | "markdown";

export type FilePreviewRenderer = "image" | "audio" | "video" | "pdf" | "markdown" | "text";
export interface PluginFilePreview {
  id: string;
  name: string;
  renderer: FilePreviewRenderer;
  extensions: string[];
}
export interface FilePreviewInfo {
  id: string;
  size: number;
  renderer: FilePreviewRenderer;
}
export interface PluginFileIcon {
  symbol: FileIconSymbol;
  color?: string;
  label?: string;
}
export interface PluginFileIconTheme {
  id: string;
  name: string;
  icons: Record<string, PluginFileIcon>;
  extensions: Record<string, string>;
  fileNames: Record<string, string>;
  defaultIcon?: string;
}
export interface PluginTheme {
  id: string;
  name: string;
  appearance: "light" | "dark";
  accent?: string;
  colors: ColorOverrides;
}
export interface PluginSecurityState {
  restricted: boolean;
  cliLocked: boolean;
  recoverySuggested: boolean;
  reason: string | null;
  grants: Record<string, string[]>;
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
