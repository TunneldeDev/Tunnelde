import type { ComponentType } from "react";
import type { PluginInfo } from "@/lib/api/types";
import { parsePanelViewCapsule } from "@/lib/panels/viewState";
import { uiSdk, type FrontendModule, type FrontendViewProps } from "../../uiSdk";
import { ResourceScopeClosed } from "../scopes/errors";
import type { ResourceScope } from "../scopes/contracts";
import type { UiResourceOptions } from "../../contracts/runtime/resources";
import type { FrontendSession, FrontendTransport } from "../../frontendRuntime";

export interface MountedFrontendView {
  component: ComponentType<FrontendViewProps>;
  resources: ResourceScope;
  /** False means state preservation is unavailable, not an empty snapshot. */
  stateful: boolean;
  captureState(): Promise<unknown>;
  dispose(): void;
}

function cloneState(value: unknown): unknown {
  // The same bounded, strict JSON contract as native panel capsules. Do not
  // silently stringify dates, functions, nonfinite numbers or sparse arrays.
  return parsePanelViewCapsule({ version: 1, fields: { plugin: value } }).fields.plugin;
}

/** No engine start, singleton activation, background runner or global registry.
 * A document/panel gateway must separately authorize a satellite transport.
 */
export async function openFrontendView({
  plugin,
  viewId,
  activation,
  parent,
  transport,
  openView,
  check,
  state,
  signal,
}: {
  plugin: PluginInfo;
  viewId: string;
  activation: FrontendSession;
  parent: ResourceScope;
  transport: FrontendTransport;
  openView: NonNullable<FrontendTransport["openView"]>;
  check: () => void;
  state?: { value: unknown };
  signal?: AbortSignal;
}): Promise<MountedFrontendView> {
  check();
  const restored = state ? { value: cloneState(state.value) } : undefined;
  const scope = parent.child({ signal });
  const live = () => {
    if (scope.signal.aborted) throw new ResourceScopeClosed();
    check();
  };
  try {
    const session = await scope.acquire(
      () => openView(activation.token, viewId, crypto.randomUUID()),
      (session) => {
        // A malformed view reply must never close the singleton activation.
        if (session.token !== activation.token) return transport.close(session.token);
      },
      { timeoutMs: 15_000 },
    );
    live();
    if (
      session.pluginId !== plugin.id ||
      session.runtimeId !== activation.runtimeId ||
      session.generation !== activation.generation ||
      session.sdkVersion !== uiSdk.version ||
      session.entry !== activation.entry ||
      session.token === activation.token
    )
      throw new ResourceScopeClosed();
    const module: FrontendModule = await scope.run(() => transport.load(session), {
      timeoutMs: 15_000,
    });
    live();
    if (typeof module.createView !== "function")
      throw new Error("plugin.frontend.viewFactoryUnavailable");
    const instance = await scope.acquire(
      () =>
        module.createView!(
          Object.freeze({
            sdk: uiSdk,
            pluginId: plugin.id,
            viewId,
            signal: scope.signal,
            resources: scope,
            api: Object.freeze({
              call: <T>(
                method: string,
                params: Record<string, unknown> = {},
                options: UiResourceOptions = {},
              ) => {
                live();
                return scope.run(
                  (signal) => transport.call<T>(session.token, method, params, signal),
                  { timeoutMs: 60_000, ...options },
                );
              },
            }),
          }),
        ),
      (instance) => {
        if (typeof instance?.dispose === "function") return instance.dispose();
      },
      { timeoutMs: 15_000 },
    );
    live();
    if (!instance || typeof instance.component !== "function")
      throw new Error("plugin.frontend.invalidViewFactory");
    const capture = instance.captureState;
    const restore = instance.restoreState;
    if (
      (capture !== undefined || restore !== undefined) &&
      (typeof capture !== "function" || typeof restore !== "function")
    )
      throw new Error("plugin.frontend.invalidViewFactory");
    if (restored) {
      if (!restore) throw new Error("plugin.frontend.viewStateUnavailable");
      await scope.run(() => restore.call(instance, restored.value), { timeoutMs: 15_000 });
      live();
    }
    return {
      component: instance.component,
      resources: scope,
      stateful: !!capture,
      captureState: async () => {
        live();
        if (!capture) throw new Error("plugin.frontend.viewStateUnavailable");
        const value = await scope.run(() => capture.call(instance), { timeoutMs: 15_000 });
        live();
        return cloneState(value);
      },
      dispose: () => scope.dispose(),
    };
  } catch (error) {
    scope.dispose();
    throw error;
  }
}
