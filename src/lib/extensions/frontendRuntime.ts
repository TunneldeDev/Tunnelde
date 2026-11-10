import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import type { PluginInfo, PluginSecurityState } from "@/lib/api/types";
import { reportError } from "@/lib/diagnostics";
import {
  createResourceScope,
  ResourceScopeClosed,
  ResourceScopeError,
  type ResourceScope,
} from "./resourceScope";
import { uiSdk, type FrontendContext, type FrontendModule, type FrontendViewProps } from "./uiSdk";

import { createBackgroundTaskRunner } from "./backgroundTasks/execution";
import { samePluginRuntime } from "@/lib/plugins/commands/runtime";
import { usePlugins } from "@/store/plugins";

interface Session {
  token: string;
  pluginId: string;
  generation: number;
  runtimeId: string;
  entry: string;
  sdkVersion: string;
}
interface Runtime {
  plugin: PluginInfo;
  scope: ResourceScope;
  ready: Promise<void>;
  activated: boolean;
  retiring: boolean;
  token?: string;
  views: Map<string, ComponentType<FrontendViewProps>>;
  commands: Map<
    string,
    (input: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>
  >;
}

export interface FrontendTransport {
  open(id: string, runtimeId: string): Promise<Session>;
  current(plugin: PluginInfo): boolean;
  ready(token: string): Promise<void>;
  close(token: string): Promise<void>;
  fail(token: string): Promise<void>;
  call<T>(token: string, method: string, params: Record<string, unknown>): Promise<T>;
  load(session: Session): Promise<FrontendModule>;
  report(pluginId: string, operation: string, error: unknown): void;
}

export function createFrontendRuntime(transport: FrontendTransport) {
  const runtimes = new Map<string, Runtime>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const changed = () => {
    revision++;
    for (const receive of listeners) {
      try {
        receive();
      } catch (error) {
        transport.report("host", "subscription", error);
      }
    }
  };
  const stop = (id: string) => {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    runtimes.delete(id);
    runtime.scope.dispose();
    runtime.views.clear();
    runtime.commands.clear();
    changed();
  };
  const ensure = async (plugin: PluginInfo): Promise<Runtime> => {
    if (!plugin.frontend || plugin.status !== "running" || !plugin.runtimeId)
      throw new Error("plugin.notRunning");
    if (!transport.current(plugin)) throw new ResourceScopeClosed();
    let runtime = runtimes.get(plugin.id);
    if (runtime && !samePluginRuntime(runtime.plugin, plugin)) {
      stop(plugin.id);
      runtime = undefined;
    }
    if (!runtime) {
      const scope = createResourceScope({
        report: (error) => transport.report(plugin.id, "cleanup", error),
      });
      const current: Runtime = {
        plugin,
        scope,
        ready: Promise.resolve(),
        activated: false,
        retiring: false,
        views: new Map(),
        commands: new Map(),
      };
      runtime = current;
      runtimes.set(plugin.id, current);
      const live = () => {
        if (
          current.retiring ||
          scope.signal.aborted ||
          runtimes.get(plugin.id) !== current ||
          !transport.current(plugin)
        )
          throw new ResourceScopeClosed();
      };
      const register = <T>(map: Map<string, T>, id: string, value: T, declared: boolean) => {
        live();
        if (!declared || typeof value !== "function")
          throw new Error("plugin.frontend.undeclaredContribution");
        if (map.has(id)) throw new Error("plugin.frontend.duplicateContribution");
        map.set(id, value);
        const release = scope.use(() => {
          if (map.get(id) === value) {
            map.delete(id);
            changed();
          }
        });
        changed();
        return release;
      };
      current.ready = (async () => {
        try {
          const session = await scope.acquire(
            () => transport.open(plugin.id, plugin.runtimeId!),
            (session) => transport.close(session.token),
            { timeoutMs: 15_000 },
          );
          live();
          if (session.sdkVersion !== uiSdk.version || session.pluginId !== plugin.id)
            throw new Error("plugin.frontend.sdkMismatch");
          if (session.runtimeId !== plugin.runtimeId) throw new ResourceScopeClosed();
          current.token = session.token;
          const module = await scope.run(() => transport.load(session), { timeoutMs: 15_000 });
          live();
          if (typeof module.activate !== "function")
            throw new Error("plugin.frontend.missingActivate");
          const context: FrontendContext = Object.freeze({
            sdk: uiSdk,
            pluginId: plugin.id,
            signal: scope.signal,
            resources: scope,
            backgroundTasks: createBackgroundTaskRunner(scope.signal, live, plugin.id),
            api: Object.freeze({
              call: <T>(method: string, params: Record<string, unknown> = {}) => {
                live();
                return scope.run(() => transport.call<T>(session.token, method, params), {
                  timeoutMs: 60_000,
                });
              },
            }),
            views: Object.freeze({
              register: (id: string, component: ComponentType<FrontendViewProps>) =>
                register(
                  current.views,
                  id,
                  component,
                  plugin.views.some((view) => view.id === id && view.kind === "component"),
                ),
            }),
            commands: Object.freeze({
              register: (
                id: string,
                handler: Runtime["commands"] extends Map<string, infer H> ? H : never,
              ) =>
                register(
                  current.commands,
                  id,
                  handler,
                  plugin.commands.some(
                    (command) =>
                      command.id === id && (plugin.runtime === "frontend" || command.frontend),
                  ),
                ),
            }),
          });
          await scope.acquire(
            () => module.activate(context),
            (cleanup) => cleanup?.(),
            { timeoutMs: 15_000 },
          );
          live();
          await scope.run(() => transport.ready(session.token), { timeoutMs: 15_000 });
          live();
          current.activated = true;
          changed();
        } catch (error) {
          current.retiring = true;
          if (runtimes.get(plugin.id) === current) {
            if (current.token && !(error instanceof ResourceScopeClosed)) {
              try {
                await scope.run(() => transport.fail(current.token!), { timeoutMs: 15_000 });
              } catch (failure) {
                transport.report(plugin.id, "retire-failed-activation", failure);
              }
            }
            if (runtimes.get(plugin.id) === current) stop(plugin.id);
          }
          if (!(error instanceof ResourceScopeClosed))
            transport.report(plugin.id, "activate", error);
          throw error;
        }
      })();
    }
    await runtime.ready;
    if (
      runtimes.get(plugin.id) !== runtime ||
      runtime.scope.signal.aborted ||
      !transport.current(plugin)
    )
      throw new ResourceScopeClosed();
    return runtime;
  };
  return {
    ensure: async (plugin: PluginInfo) => {
      await ensure(plugin);
    },
    async run(
      plugin: PluginInfo,
      command: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) throw new ResourceScopeError("extension.scope.cancelled");
      const runtime = await ensure(plugin);
      const handler = runtime.commands.get(command);
      if (!handler) throw new Error("plugin.frontend.commandUnavailable");
      return runtime.scope.run((lifetime) => handler(input, lifetime), {
        signal,
        timeoutMs: 60_000,
      });
    },
    view: (id: string, viewId: string, fingerprint?: string) => {
      const runtime = runtimes.get(id);
      return runtime?.activated &&
        !runtime.retiring &&
        !runtime.scope.signal.aborted &&
        transport.current(runtime.plugin) &&
        (fingerprint === undefined || runtime.plugin.fingerprint === fingerprint)
        ? runtime.views.get(viewId)
        : undefined;
    },
    token: (id: string) => runtimes.get(id)?.token,
    /** Domain providers use the selected runtime's existing transport and quotas. */
    async call<T>(
      id: string,
      token: string,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      const runtime = runtimes.get(id);
      const live = () => {
        if (
          !runtime ||
          runtimes.get(id) !== runtime ||
          runtime.token !== token ||
          !runtime.activated ||
          runtime.retiring ||
          !transport.current(runtime.plugin) ||
          runtime.scope.signal.aborted
        )
          throw new ResourceScopeClosed();
      };
      live();
      const result = await runtime!.scope.run(() => transport.call<T>(token, method, params), {
        timeoutMs: 30_000,
      });
      live();
      return result;
    },
    stop,
    dispose: () => {
      for (const id of [...runtimes.keys()]) stop(id);
    },
    revision: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reconcileSecurity: (state: PluginSecurityState) => {
      for (const [id, runtime] of runtimes) {
        const grant = state.grants[id];
        if (
          state.restricted ||
          !grant ||
          runtime.plugin.permissions.some((p) => !grant.includes(p))
        )
          stop(id);
      }
    },
    reconcile: (plugins: PluginInfo[], restricted: boolean) => {
      for (const [id, runtime] of runtimes) {
        const plugin = plugins.find((item) => item.id === id);
        if (
          restricted ||
          !plugin ||
          plugin.status !== "running" ||
          !samePluginRuntime(plugin, runtime.plugin)
        )
          stop(id);
      }
    },
  };
}

export const frontendRuntime = createFrontendRuntime({
  open: (id, runtimeId) => invoke("plugin_frontend_open", { id, runtimeId }),
  current: (plugin) => {
    const state = usePlugins.getState();
    return (
      !state.stoppingIds.includes(plugin.id) &&
      samePluginRuntime(
        state.items.find((item) => item.id === plugin.id),
        plugin,
      )
    );
  },
  ready: (token) => invoke("plugin_frontend_ready", { token }),
  close: (token) => invoke("plugin_frontend_close", { token }),
  fail: async (token) => {
    await invoke("plugin_frontend_failed", { token });
  },
  call: (token, method, params) => invoke("plugin_frontend_call", { token, method, params }),
  load: (session) => {
    const base = convertFileSrc(session.token, "tunnelde-ui");
    const url = `${base}/${session.entry.split("/").map(encodeURIComponent).join("/")}`;
    return import(/* @vite-ignore */ url) as Promise<FrontendModule>;
  },
  report: (id, operation, error) => reportError(`plugins.${id}.frontend`, operation, error),
});

if (import.meta.hot) import.meta.hot.dispose(() => frontendRuntime.dispose());
