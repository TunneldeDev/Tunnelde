import type { PreviewWindowAction } from "@/features/sftp/preview/windowActions";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { FrontendSession } from "@/lib/extensions/frontendRuntime";
import type { FrontendModule } from "@/lib/extensions/uiSdk";
import type { FrontendViewTransport } from "@/lib/extensions/runtime/views/frontend";
import { ResourceScopeClosed } from "@/lib/extensions/runtime/scopes/errors";
import { callScopedRequest } from "@/lib/extensions/runtime/requests/frontend";
import type { ForwardingWindowMutation } from "@/features/forwarding/runtime/windowProtocol";
import type {
  NativePanelIdentity,
  NativePluginViewDescriptor,
  NativeForwardingProviderDescriptor,
  NativePreviewProviderDescriptor,
  PanelLease,
} from "./windowProtocol";

export type NativePluginViewTarget =
  { kind: "owned"; lease: PanelLease } | { kind: "staged"; id: string };
type Request =
  | { action: "describePreviewProvider"; target: NativePluginViewTarget }
  | {
      action: "openPreviewProvider";
      target: NativePluginViewTarget;
      pluginId: string;
      runtimeId: string;
      viewId: string;
      selectionRevision: number;
      sourceKind: "local" | "remote";
    }
  | ({ action: "submitPreviewProviderAction"; token: string; lease: PanelLease } & Omit<
      PreviewWindowAction,
      "kind"
    >)
  | { action: "forwarding"; token: string; lease: PanelLease; request: ForwardingWindowMutation }
  | { action: "describeTasksProvider"; target: NativePluginViewTarget }
  | {
      action: "openTasksProvider";
      target: NativePluginViewTarget;
      pluginId: string;
      runtimeId: string;
      viewId: string;
      selectionRevision: number;
    }
  | {
      action: "submitTasksProviderAction";
      token: string;
      lease: PanelLease;
      key: string;
      ticket: string;
      actionId: string;
    }
  | { action: "describeForwardingProvider"; target: NativePluginViewTarget }
  | {
      action: "openForwardingProvider";
      target: NativePluginViewTarget;
      hostId: string;
      pluginId: string;
      runtimeId: string;
      viewId: string;
      selectionRevision: number;
    }
  | {
      action: "unregisterAdapter";
      panelId: string;
      runtimeId: string;
      generation: number;
      revision: string;
    }
  | { action: "registerAdapter"; pluginId: string; runtimeId: string; viewId: string }
  | {
      action: "open";
      target: NativePluginViewTarget;
      pluginId: string;
      runtimeId: string;
      viewId: string;
    }
  | { action: "prepareCall" | "close"; token: string }
  | { action: "cancelCall"; token: string; requestId: string }
  | {
      action: "call";
      token: string;
      requestId: string;
      method: string;
      params: Record<string, unknown>;
    };
type NativeInvoke = <T>(
  command: "panel_window_plugin_view",
  args: { document: string; request: Request },
) => Promise<T>;

/** A document's view attachments, not a second plugin runtime. Only this closed
 * gateway is reachable; the singleton activation token is never needed. */
export function createNativePluginViewClient(
  identity: NativePanelIdentity,
  options: {
    report: (error: unknown) => void;
    invoke?: NativeInvoke;
    load?: (url: string) => Promise<FrontendModule>;
  },
) {
  const document = identity.document;
  const native = options.invoke ?? invoke;
  const load = options.load ?? ((url: string) => import(/* @vite-ignore */ url));
  const tokens = new Set<string>();
  const calls = new Set<AbortController>();
  let disposed = false;
  const check = (token?: string) => {
    if (disposed || (token !== undefined && !tokens.has(token))) throw new ResourceScopeClosed();
  };
  const request = <T>(request: Request) =>
    native<T>("panel_window_plugin_view", { document, request: structuredClone(request) });
  const close = async (token: string) => {
    if (!tokens.delete(token)) return;
    // Cleanup remains possible after disposal and does not touch background
    // runtime resources, subscriptions or private Bus membership.
    await request({ action: "close", token });
  };
  const acceptSession = async (session: FrontendSession) => {
    if (!session || typeof session.token !== "string" || !session.token)
      throw new ResourceScopeClosed();
    tokens.add(session.token);
    if (disposed) {
      await close(session.token);
      throw new ResourceScopeClosed();
    }
    return session;
  };
  const transport: FrontendViewTransport = {
    close,
    async load(session) {
      check(session.token);
      const base = convertFileSrc(session.token, "tunnelde-ui");
      const module = await load(
        `${base}/${session.entry.split("/").map(encodeURIComponent).join("/")}`,
      );
      check(session.token);
      return module;
    },
    async call<T>(
      token: string,
      method: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      check(token);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      calls.add(controller);
      try {
        const value = await callScopedRequest<T>(
          {
            prepare: (token) => request<string>({ action: "prepareCall", token }),
            cancel: (token, requestId) =>
              tokens.has(token)
                ? request({ action: "cancelCall", token, requestId })
                : Promise.resolve(false),
            call: <R>(
              token: string,
              requestId: string,
              method: string,
              params: Record<string, unknown>,
            ) => request<R>({ action: "call", token, requestId, method, params }),
          },
          options.report,
          token,
          method,
          params,
          controller.signal,
        );
        check(token);
        return value;
      } finally {
        calls.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
  return {
    transport,
    async forwardingMutation<T = unknown>(
      token: string,
      lease: PanelLease,
      mutation: ForwardingWindowMutation,
    ): Promise<T> {
      check(token);
      const result = await request<T>({ action: "forwarding", token, lease, request: mutation });
      check(token);
      return result;
    },
    async registerAdapter(pluginId: string, runtimeId: string, viewId: string) {
      check();
      if (identity.windowId !== "main") throw new Error("panel.window.coordinatorRequired");
      const descriptor = await request<NativePluginViewDescriptor>({
        action: "registerAdapter",
        pluginId,
        runtimeId,
        viewId,
      });
      check();
      return descriptor;
    },
    async unregisterAdapter(
      descriptor: Pick<
        NativePluginViewDescriptor,
        "panelId" | "runtimeId" | "generation" | "revision"
      >,
    ) {
      check();
      if (identity.windowId !== "main") throw new Error("panel.window.coordinatorRequired");
      const changed = await request<boolean>({
        action: "unregisterAdapter",
        panelId: descriptor.panelId,
        runtimeId: descriptor.runtimeId,
        generation: descriptor.generation,
        revision: descriptor.revision,
      });
      check();
      return changed;
    },
    async describePreviewProvider(target: NativePluginViewTarget) {
      check();
      const value = await request<NativePreviewProviderDescriptor | null>({
        action: "describePreviewProvider",
        target,
      });
      check();
      return value;
    },
    async openPreviewProvider(
      target: NativePluginViewTarget,
      descriptor: NativePreviewProviderDescriptor,
    ) {
      check();
      return acceptSession(
        await request<FrontendSession>({
          action: "openPreviewProvider",
          target,
          pluginId: descriptor.view.pluginId,
          runtimeId: descriptor.view.runtimeId,
          viewId: descriptor.view.viewId,
          selectionRevision: descriptor.selectionRevision,
          sourceKind: descriptor.sourceKind,
        }),
      );
    },
    async submitPreviewProviderAction(
      token: string,
      lease: PanelLease,
      value: PreviewWindowAction,
    ) {
      check(token);
      return request<string>({
        action: "submitPreviewProviderAction",
        token,
        lease,
        id: value.id,
        attemptId: value.attemptId,
        revision: value.revision,
        command: value.command,
      });
    },
    async describeTasksProvider(target: NativePluginViewTarget) {
      check();
      const value = await request<NativeForwardingProviderDescriptor | null>({
        action: "describeTasksProvider",
        target,
      });
      check();
      return value;
    },
    async openTasksProvider(
      target: NativePluginViewTarget,
      descriptor: NativeForwardingProviderDescriptor,
    ) {
      check();
      return acceptSession(
        await request<FrontendSession>({
          action: "openTasksProvider",
          target,
          pluginId: descriptor.view.pluginId,
          runtimeId: descriptor.view.runtimeId,
          viewId: descriptor.view.viewId,
          selectionRevision: descriptor.selectionRevision,
        }),
      );
    },
    async submitTasksProviderAction(
      token: string,
      lease: PanelLease,
      key: string,
      ticket: string,
      actionId: string,
    ) {
      check(token);
      // Return even after disposal so the owner can cancel an unclaimed receipt.
      return request<string>({
        action: "submitTasksProviderAction",
        token,
        lease,
        key,
        ticket,
        actionId,
      });
    },
    async describeForwardingProvider(target: NativePluginViewTarget) {
      check();
      const value = await request<NativeForwardingProviderDescriptor | null>({
        action: "describeForwardingProvider",
        target,
      });
      check();
      return value;
    },
    async openForwardingProvider(
      target: NativePluginViewTarget,
      hostId: string,
      descriptor: NativeForwardingProviderDescriptor,
    ) {
      check();
      const session = await request<FrontendSession>({
        action: "openForwardingProvider",
        target,
        hostId,
        pluginId: descriptor.view.pluginId,
        runtimeId: descriptor.view.runtimeId,
        viewId: descriptor.view.viewId,
        selectionRevision: descriptor.selectionRevision,
      });
      return acceptSession(session);
    },
    async open(
      target: NativePluginViewTarget,
      pluginId: string,
      runtimeId: string,
      viewId: string,
    ) {
      check();
      const session = await request<FrontendSession>({
        action: "open",
        target,
        pluginId,
        runtimeId,
        viewId,
      });
      return acceptSession(session);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of calls) controller.abort();
      for (const token of tokens) {
        void close(token).catch((error) => {
          try {
            options.report(error);
          } catch {
            /* Cleanup is terminal. */
          }
        });
      }
    },
  };
}
