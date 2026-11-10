import type { PluginInfo } from "@/lib/api/types";
import type { Dispose } from "@/lib/events/bus";
import type { Subscription } from "@/lib/events/lifecycle";
import type { FrontendActivation } from "@/lib/plugins/activation/contracts";

interface Transport {
  subscribe(handler: (request: FrontendActivation) => void, signal: AbortSignal): Promise<Dispose>;
  read(): { items: PluginInfo[]; stoppingIds: string[] };
  load(request?: FrontendActivation): Promise<unknown>;
  ensure(plugin: PluginInfo): Promise<unknown>;
  report(error: unknown): void;
}

/** Bootstrap owns this bridge. It only activates an already admitted exact
 * runtime; it cannot approve plugins or start an engine from an event. */
export function createPluginActivationBridge(transport: Transport) {
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  const current = (request: FrontendActivation) => {
    const state = transport.read();
    if (state.stoppingIds.includes(request.id)) return;
    return state.items.find(
      (plugin) =>
        plugin.id === request.id &&
        plugin.runtimeId === request.runtimeId &&
        plugin.status === "running" &&
        plugin.frontend,
    );
  };
  const activate = (request: FrontendActivation, signal: AbortSignal): Promise<void> => {
    if (
      disposed ||
      signal.aborted ||
      typeof request?.id !== "string" ||
      typeof request.runtimeId !== "string" ||
      !request.id ||
      !request.runtimeId ||
      request.id.length > 256 ||
      request.runtimeId.length > 256
    )
      return Promise.resolve();
    const key = JSON.stringify([request.id, request.runtimeId]);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 64) return Promise.reject(new Error("plugin.api.busy"));
    const work = Promise.resolve()
      .then(async () => {
        if (disposed || signal.aborted) return;
        // State and activation events may arrive in either order. Load through
        // the revision-aware store instead of applying an event over newer state.
        if (!current(request)) await transport.load(request);
        if (disposed || signal.aborted) return;
        const plugin = current(request);
        if (plugin) await transport.ensure(plugin);
      })
      .finally(() => {
        if (pending.get(key) === work) pending.delete(key);
      });
    pending.set(key, work);
    return work;
  };
  const subscription: Subscription = {
    register: (signal) =>
      transport.subscribe((request) => {
        void activate(request, signal).catch((error) => {
          if (!disposed && !signal.aborted) transport.report(error);
        });
      }, signal),
    recover: async (signal) => {
      await transport.load();
      if (disposed || signal.aborted) return;
      // Recover missed activation requests, never start stopped plugins.
      for (const plugin of transport.read().items) {
        if (disposed || signal.aborted) return;
        if (plugin.status === "running" && plugin.frontend && plugin.runtimeId)
          await activate({ id: plugin.id, runtimeId: plugin.runtimeId }, signal);
      }
    },
  };
  return {
    subscription,
    dispose() {
      disposed = true;
      pending.clear();
    },
  };
}
