import { createFrontendFactoryComponent } from "@/lib/extensions/runtime/views/factory";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { NativeForwardingProviderDescriptor } from "@/lib/panels/windowProtocol";
import type { NativePluginViewTarget } from "@/lib/panels/windowPluginClient";
import { openWindowForwardingProviderView } from "./windowProvider";

function targetKey(target: NativePluginViewTarget) {
  return JSON.stringify(
    target.kind === "staged"
      ? [target.kind, target.id]
      : [target.kind, target.lease.panelId, target.lease.windowId, target.lease.generation],
  );
}

export interface WindowForwardingViewOwner {
  client: PanelWindowClient;
  target(): NativePluginViewTarget;
  check(mutation: boolean): void;
}
function descriptorKey(descriptor: NativeForwardingProviderDescriptor | null) {
  if (!descriptor) return null;
  const { view } = descriptor;
  return JSON.stringify([
    descriptor.selectionRevision,
    descriptor.capabilities.write,
    view.pluginId,
    view.runtimeId,
    view.generation,
    view.viewId,
    view.entry,
    view.sdkVersion,
    view.title,
    view.allowFloating,
  ]);
}
/** Native metadata owns selection; JS never starts a singleton or consults main stores. */
export function createWindowForwardingProviderSource(
  owner: WindowForwardingViewOwner,
  hostId: string,
  report: (error: unknown) => void,
) {
  const listeners = new Set<() => void>();
  type Source = {
    id: string;
    descriptor: NativeForwardingProviderDescriptor;
    View: ReturnType<typeof createFrontendFactoryComponent>;
    check(mutation: boolean): void;
    retire(): void;
  };
  let snapshot: { loading: boolean; source: Source | null; error: unknown } = {
    loading: true,
    source: null,
    error: null,
  };
  let active: { refresh(reset?: boolean): void; stop(): void } | null = null;
  const publish = (value: typeof snapshot) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => active?.refresh(true),
    revalidate: () => active?.refresh(),
    start() {
      active?.stop();
      let stopped = false,
        queued = false,
        running = false,
        reset = false;
      let unsubscribe: (() => void) | undefined;
      let current: Source | null = null;
      const client = owner.client.pluginViews(report);
      const refresh = (restart = false) => {
        if (stopped) return;
        queued = true;
        reset ||= restart;
        if (running) return;
        running = true;
        void (async () => {
          try {
            while (queued && !stopped) {
              queued = false;
              const force = reset;
              reset = false;
              owner.check(false);
              const target = structuredClone(owner.target());
              let descriptor: NativeForwardingProviderDescriptor | null;
              try {
                descriptor = await client.describeForwardingProvider(target);
              } catch (error) {
                if (stopped) return;
                owner.check(false);
                // Native promotion can retire a staged target while its read is
                // in flight. Retry only for this display owner's changed target,
                // never by weakening native authorization or resetting its draft.
                if (targetKey(target) !== targetKey(owner.target())) {
                  queued = true;
                  reset ||= force;
                  continue;
                }
                throw error;
              }
              if (stopped) return;
              owner.check(false);
              if (targetKey(target) !== targetKey(owner.target())) {
                queued = true;
                reset ||= force;
                continue;
              }
              if (
                force ||
                descriptorKey(current?.descriptor ?? null) !== descriptorKey(descriptor)
              ) {
                current?.retire();
                current = null;
                if (descriptor) {
                  const lifetime = new AbortController();
                  const selected = structuredClone(descriptor);
                  const check = (mutation: boolean) => {
                    if (stopped || lifetime.signal.aborted)
                      throw new Error("plugin.forwarding.expired");
                    owner.check(mutation);
                  };
                  const View = createFrontendFactoryComponent(async (signal, state) => {
                    check(false);
                    const parent = createResourceScope({ parent: lifetime.signal, report });
                    try {
                      const mounted = await openWindowForwardingProviderView({
                        client,
                        target: owner.target(),
                        descriptor: selected,
                        hostId,
                        parent,
                        check: () => check(false),
                        state,
                        signal,
                      });
                      return { ...mounted, dispose: () => parent.dispose() };
                    } catch (error) {
                      parent.dispose();
                      throw error;
                    }
                  });
                  current = {
                    id: crypto.randomUUID(),
                    descriptor: selected,
                    View,
                    check,
                    retire: () => lifetime.abort(),
                  };
                }
              }
              publish({ loading: false, source: current, error: null });
            }
          } catch (error) {
            // A failed discovery read is not proof of a selection change. Keep
            // the actual draft/attachment; native effects still reauthorize.
            if (!stopped)
              publish({
                loading: false,
                source: current,
                error: error ?? new Error("plugin.frontend.viewUnavailable"),
              });
          } finally {
            running = false;
            if (queued && !stopped) refresh();
          }
        })();
      };
      const subscription = {
        refresh,
        stop() {
          if (stopped) return;
          stopped = true;
          current?.retire();
          unsubscribe?.();
          if (active === subscription) active = null;
        },
      };
      active = subscription;
      publish({ loading: true, source: null, error: null });
      void owner.client
        .subscribeForwardingProvider(() => refresh())
        .then(
          (stop) => {
            if (stopped) stop();
            else {
              unsubscribe = stop;
              refresh();
            }
          },
          (error) => {
            if (!stopped)
              publish({
                loading: false,
                source: current,
                error: error ?? new Error("plugin.frontend.viewUnavailable"),
              });
          },
        );
      refresh();
      return subscription.stop;
    },
  };
}
