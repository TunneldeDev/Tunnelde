import { createResourceScope } from "@/lib/extensions/resourceScope";
import { nativeEvents, type NativeEvents } from "@/lib/events/native";
import { createSubscriptionGroup, type Dispose } from "@/lib/events/bus";

/** Common lifecycle for runtime-owned UI snapshots, independent of any view or store. */
export interface ContributionSource<T extends { revision: number }> {
  read(signal: AbortSignal): Promise<T>;
  changed(receive: (snapshot: T) => void, signal: AbortSignal): Promise<Dispose>;
  invalidated(receive: () => void, signal: AbortSignal): Promise<Dispose>;
  resumed(receive: () => void, signal: AbortSignal): Promise<Dispose>;
  apply(snapshot: T): void;
  clear(): void;
  report(error: unknown): void;
}

/** Subscribe first; revocation fences all pre-revocation reads and queued events. */
export async function synchronizeContributions<T extends { revision: number }>(
  source: ContributionSource<T>,
  signal: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<Dispose> {
  const report = (error: unknown) => {
    try {
      source.report(error);
    } catch {
      /* A diagnostics failure must not break reconciliation or disposal. */
    }
  };
  const scope = createResourceScope({ parent: signal, report });
  const operation = { timeoutMs: options.timeoutMs ?? 30_000 };
  let revision = -1;
  let request = 0;
  let barrier = false;
  let invalidation = 0;
  let changedWhileBlocked = false;
  const live = () => !scope.signal.aborted;
  const accept = (snapshot: T) => {
    if (live() && snapshot.revision >= revision) {
      revision = snapshot.revision;
      source.apply(snapshot);
    }
  };
  const refresh = async () => {
    const current = ++request;
    const epoch = invalidation;
    changedWhileBlocked = false;
    try {
      const snapshot = await scope.run((lifetime) => source.read(lifetime), operation);
      if (!live() || current !== request || epoch !== invalidation) return;
      // A changed event during the security fence requires another authoritative read.
      if (barrier && changedWhileBlocked) {
        void refresh();
        return;
      }
      barrier = false;
      accept(snapshot);
    } catch (error) {
      if (live() && current === request) report(error);
    }
  };
  const group = createSubscriptionGroup([
    (lifetime) =>
      source.changed((snapshot) => {
        if (!live()) return;
        if (barrier) {
          changedWhileBlocked = true;
          return;
        }
        if (snapshot.revision <= revision) return;
        ++request;
        accept(snapshot);
      }, lifetime),
    (lifetime) =>
      source.invalidated(() => {
        if (!live()) return;
        ++invalidation;
        barrier = true;
        source.clear();
        void refresh();
      }, lifetime),
    (lifetime) =>
      source.resumed(() => {
        if (live()) void refresh();
      }, lifetime),
  ]);
  scope.use(() => {
    ++request;
    group.dispose();
  });
  try {
    if (live()) {
      await scope.run(() => group.start(), operation);
      await refresh();
    }
  } catch (error) {
    scope.dispose();
    if (!signal.aborted) throw error;
  }
  return () => scope.dispose();
}

/** Reusable native transport, keeping the synchronization protocol testable without Tauri. */
export function nativeContributionSource<
  K extends
    | "plugin://status-bar-changed"
    | "plugin://tab-bar-changed"
    | "plugin://host-list-changed"
    | "plugin://host-columns-changed"
    | "plugin://host-sources-changed",
>(
  event: K,
  options: Pick<ContributionSource<NativeEvents[K]>, "read" | "apply" | "clear" | "report">,
): ContributionSource<NativeEvents[K]> {
  return {
    ...options,
    changed: (receive, signal) => nativeEvents.on(event, receive, signal),
    invalidated: (receive, signal) => nativeEvents.on("plugin:security-changed", receive, signal),
    resumed: async (receive, signal) => {
      const group = createSubscriptionGroup([
        (lifetime) => nativeEvents.on("ui://resume", receive, lifetime),
        (lifetime) => nativeEvents.on("plugin://state", receive, lifetime),
      ]);
      const dispose = () => group.dispose();
      signal.addEventListener("abort", dispose, { once: true });
      try {
        if (!signal.aborted) await group.start();
      } catch (error) {
        signal.removeEventListener("abort", dispose);
        group.dispose();
        throw error;
      }
      if (signal.aborted) group.dispose();
      return () => {
        signal.removeEventListener("abort", dispose);
        group.dispose();
      };
    },
  };
}
