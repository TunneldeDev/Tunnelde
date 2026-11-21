/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { UiSdk } from "../components/sdk.js";
import type { UiResourceScope, UiResourceOptions } from "../runtime/resources.js";
import type { FrontendBackgroundTaskRunner } from "../backgroundTasks/execution.js";
import type { FrontendViewProps } from "./views.js";

export interface FrontendContext {
  readonly sdk: UiSdk;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly resources: UiResourceScope;
  /** Available on hosts with frontend.backgroundTasks execution discovery. */
  readonly backgroundTasks?: FrontendBackgroundTaskRunner;
  /** Calls retain existing RPC authorization, size limits and stable contracts. */
  readonly api: {
    call<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: UiResourceOptions,
    ): Promise<T>;
  };
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
  /** Opt-in view factory. Loading a view never calls activate a second time.
   * Ordinary factory-only views get a host renderer; providers still require
   * their explicit synchronous renderer/slot contract. Legacy modules remain
   * supported in their originating document.
   */
  createView?(context: FrontendViewContext): FrontendViewInstance | Promise<FrontendViewInstance>;
  activate(
    context: FrontendContext,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

/** Per-view initialization, deliberately without singleton contribution registries
 * or a background-task runner. The host calls activate only in its coordinator.
 */
export interface FrontendViewContext {
  readonly sdk: UiSdk;
  readonly pluginId: string;
  readonly viewId: string;
  readonly signal: AbortSignal;
  readonly resources: UiResourceScope;
  readonly api: FrontendContext["api"];
}

export interface FrontendViewInstance {
  readonly component: React.ComponentType<FrontendViewProps>;
  dispose?(): void | Promise<void>;
  /** Optional pair. JSON-only ephemeral UI state, never credentials or native
   * handles. Restore runs before the first render; capture must include pending
   * UI drafts. Reject when the view cannot safely move rather than truncate.
   */
  captureState?(): unknown | Promise<unknown>;
  restoreState?(state: unknown): void | Promise<void>;
}
