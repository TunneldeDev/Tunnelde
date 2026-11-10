/** Public experimental UI SDK 0.1.0. Copied verbatim to the marketplace SDK.
 * This file must not import private host modules or expose internal stores.
 */
import type * as React from "react";

export interface UiResourceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface UiResourceScope {
  readonly signal: AbortSignal;
  readonly size: number;
  use(cleanup: () => void | Promise<void>): () => void;
  acquire<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
    options?: UiResourceOptions,
  ): Promise<T>;
  run<T>(start: (signal: AbortSignal) => T | Promise<T>, options?: UiResourceOptions): Promise<T>;
  /** Abort and initiate cleanup. Cannot forcibly interrupt trusted JavaScript. */
  dispose(): void;
}
export interface UiButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "ghost-danger" | "danger";
  size?: "sm" | "md";
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}
export interface UiIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: "sm" | "md";
  ref?: React.Ref<HTMLButtonElement>;
}
export interface UiFieldProps {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}
export interface UiSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  descriptionId?: string;
}
export interface UiSearchPreset {
  /** Host search syntax always requires @field:value; metadata uses bare field names. */
  key: string;
  value: string;
  label: string;
  exclusive?: boolean;
  separatorBefore?: boolean;
}
export interface UiSearchFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "size"
> {
  value: string;
  onChange: (value: string) => void;
  presets?: readonly UiSearchPreset[];
  inputRef?: React.Ref<HTMLInputElement>;
  inputClassName?: string;
  filterLabel?: string;
  filterKeys?: readonly string[];
}
export interface UiEmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}
export interface UiSdk {
  readonly version: "0.1.0";
  /** The exact React instance used by the host renderer; never bundle a second one. */
  readonly react: typeof React;
  readonly components: Readonly<{
    Button: React.ComponentType<UiButtonProps>;
    IconButton: React.ComponentType<UiIconButtonProps>;
    Field: React.ComponentType<UiFieldProps>;
    Input: React.ComponentType<React.InputHTMLAttributes<HTMLInputElement>>;
    Textarea: React.ComponentType<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;
    Switch: React.ComponentType<UiSwitchProps>;
    SearchField: React.ComponentType<UiSearchFieldProps>;
    EmptyState: React.ComponentType<UiEmptyStateProps>;
  }>;
}
export interface FrontendViewProps {
  pluginId: string;
  viewId: string;
  visible: boolean;
  /** Present only for a user-selected workbench provider. Mount Workspace synchronously
   * exactly once and keep it mounted. Omitting other surfaces is allowed.
   */
  workbench?: FrontendWorkbenchSlots;
  /** Present only inside an explicitly selected file-browser provider. */
  fileBrowser?: FrontendFileBrowser;
  /** Present only for a user-selected terminal provider. */
  terminal?: FrontendTerminal;
  /** Present only for a user-selected command-history provider. */
  history?: FrontendHistory;
}
/** Stored application history, not a complete shell history or terminal recording. */
export interface FrontendHistoryEntry {
  id: number;
  hostId: string;
  command: string;
  executedAt: number;
  /** Legacy oversized data is capped at 4000 UTF-16 units; it cannot be executed here. */
  truncated: boolean;
}
export interface FrontendHistorySnapshot {
  sessionId: string;
  hostId: string;
  title: string;
  revision: string;
  query: string;
  /** Entries matching the host's current query, newest first. */
  total: number;
  busy: boolean;
  error: string | null;
}
export interface FrontendHistory {
  /** Optional: mount once to compose the live native rows and their actions. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendHistorySnapshot>;
  readonly capabilities: Readonly<{ delete: boolean; clear: boolean; execute: boolean }>;
  /** At most 128 entries / 65536 UTF-16 text units, without splitting a command. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendHistoryEntry>[];
  };
  /** Same @command: / @date: syntax as the built-in search; at most 4096 UTF-16 units. */
  setQuery(query: string): void;
  refresh(): void;
  /** Existing entry in this revision; requires history.write. */
  delete(id: number): Promise<void>;
  /** Request the native confirmation dialog; requires history.write. */
  requestClear(): void;
  /** Immediately rerun an existing command in this session; requires ssh.exec.
   * Automatic recording still honors the user's Record terminal history choice.
   */
  execute(id: number): Promise<void>;
}
export interface FrontendTerminalSnapshot {
  sessionId: string;
  hostId: string | null;
  title: string;
  status: "starting" | "ready" | "suspended" | "closed";
  /** Changes whenever parsed output, scrolling, selection, geometry or status changes. */
  revision: number;
  cols: number;
  rows: number;
  buffer: "normal" | "alternate";
  totalLines: number;
  viewportY: number;
}
export interface FrontendTerminalChange {
  revision: number;
  changes: readonly ("output" | "selection" | "scroll" | "resize" | "status")[];
}
export interface FrontendTerminal {
  /** Required: mount exactly once. Moves the live host terminal without recreating its PTY. */
  readonly Screen: React.ComponentType;
  readState(): Readonly<FrontendTerminalSnapshot>;
  /** Read parsed buffer text, never raw control strings. At most 128 rows / 65536 UTF-16
   * units per page, with at most 4096 units per row. A truncated row is explicitly marked.
   * Omit offset to start at the current viewport. Pass revision for consistent pagination.
   */
  readLines(request?: { revision?: number; offset?: number }): {
    revision: number;
    offset: number;
    total: number;
    nextOffset: number | null;
    lines: readonly Readonly<{ row: number; text: string; wrapped: boolean; truncated: boolean }>[];
  };
  /** Dirty notifications, coalesced over 100ms, not a lossless output stream.
   * Re-read the snapshot after each notification. At most 16 subscriptions per terminal.
   * Host revocation, provider replacement and unmount remove subscriptions automatically.
   */
  subscribe(
    receive: (change: Readonly<FrontendTerminalChange>) => void,
    options?: { signal?: AbortSignal },
  ): () => void;
  /** At most 65536 UTF-16 units, with an explicit truncation flag. No system clipboard read. */
  readSelection(): Readonly<{ text: string; truncated: boolean }>;
  focus(): void;
  /** Same negotiated paste path as the host, at most 65536 UTF-16 units. */
  paste(text: string): void;
  /** Raw UTF-8 terminal input (including shell commands), not a shell execution result. */
  send(text: string): void;
  scrollToLine(row: number): void;
  clearSelection(): void;
}
/** Independent public file DTO; never a reference to a host store or cache. */
export interface FrontendFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}
export interface FrontendFileBrowserSnapshot {
  paneId: string;
  revision: string;
  source: Readonly<{ kind: "local" } | { kind: "remote"; sessionId: string }>;
  path: string | null;
  /** Visible entries in the host's current filter and sort order. */
  total: number;
  selectedPaths: readonly string[];
  busy: boolean;
  error: string | null;
}
export interface FrontendFileBrowser {
  /** Optional composition: mount once to reuse the live built-in file listing. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendFileBrowserSnapshot>;
  /** Pages contain at most 256 entries. Every page requires the snapshot revision. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendFileEntry>[];
  };
  /** Dispatch host navigation; completion and errors appear in a new snapshot. */
  navigate(path: string): void;
  refresh(): void;
  /** Selection is limited to the entries in this visible revision. */
  select(paths: readonly string[]): void;
  /** A directory navigates; files use the same editor/preview flow as built-in rows. */
  open(path: string, mode?: "open" | "preview"): void;
}
/** Movable host-owned surfaces. Their contents stay mounted when a provider changes. */
export interface FrontendWorkbenchSlots {
  Workspace: React.ComponentType;
  Navigation: React.ComponentType;
  Inspector: React.ComponentType;
  StatusBar: React.ComponentType;
}
export type FrontendProviderTarget =
  "hostList" | "workbench" | "fileBrowser" | "terminal" | "history";
/** Optional manifest view field; requires kind: component and a trusted frontend. */
export interface FrontendProviderContribution {
  provider?: FrontendProviderTarget;
}
export interface FrontendContext {
  readonly sdk: UiSdk;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly resources: UiResourceScope;
  /** Calls retain existing RPC authorization, size limits and stable contracts. */
  readonly api: { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> };
  readonly views: {
    register(id: string, component: React.ComponentType<FrontendViewProps>): () => void;
  };
  readonly commands: {
    register(
      id: string,
      handler: (input: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>,
    ): () => void;
  };
}
export interface FrontendModule {
  activate(
    context: FrontendContext,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
