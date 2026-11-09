import { nativeEvents, type NativeEvents } from "@/lib/events/native";
import { createSubscriptionGroup, type Dispose } from "@/lib/events/bus";

/** Common lifecycle for runtime-owned UI snapshots, independent of any view or store. */
export interface ContributionSource<T extends { revision: number }> {
  read(): Promise<T>;
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
): Promise<Dispose> {
  let disposed = false;
  let revision = -1;
  let request = 0;
  let barrier = false;
  let invalidation = 0;
  let changedWhileBlocked = false;
  const live = () => !disposed && !signal.aborted;
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
      const snapshot = await source.read();
      if (!live() || current !== request || epoch !== invalidation) return;
      // A changed event during the security fence requires another authoritative read.
      if (barrier && changedWhileBlocked) {
        void refresh();
        return;
      }
      barrier = false;
      accept(snapshot);
    } catch (error) {
      if (live() && current === request) source.report(error);
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
  const dispose = () => {
    disposed = true;
    ++request;
    group.dispose();
  };
  const abort = () => {
    dispose();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (live()) {
      await group.start();
      await refresh();
    }
  } catch (error) {
    dispose();
    signal.removeEventListener("abort", abort);
    if (!signal.aborted) throw error;
  }
  return () => {
    signal.removeEventListener("abort", abort);
    dispose();
  };
}

/** Reusable native transport, keeping the synchronization protocol testable without Tauri. */
export function nativeContributionSource<
  K extends
    "plugin://status-bar-changed" | "plugin://tab-bar-changed" | "plugin://host-list-changed",
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
