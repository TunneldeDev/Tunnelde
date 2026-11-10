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
export type FrontendProviderTarget = "hostList" | "workbench" | "fileBrowser";
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
