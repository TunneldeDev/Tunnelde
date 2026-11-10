/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { UiSdk } from "../components/sdk.js";
import type { UiResourceScope } from "../runtime/resources.js";
import type { FrontendViewProps } from "./views.js";

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
