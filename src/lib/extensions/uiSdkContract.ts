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
