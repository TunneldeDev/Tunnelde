import type { Dispose } from "./bus";

export interface Subscription {
  register: (signal: AbortSignal) => Promise<Dispose>;
  /** Read authoritative state after a failed registration is recovered. */
  recover?: (signal: AbortSignal) => void | Promise<unknown>;
}

/** Independent retries: one unavailable event must not take down healthy subscriptions. */
export function createEventLifecycle(
  subscriptions: Subscription[],
  report: (error: unknown) => void = () => {},
) {
  const controller = new AbortController();
  const stops = new Set<Dispose>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let startup: Promise<void> | undefined;
  const safely = (action: () => void) => {
    try {
      action();
    } catch (error) {
      try {
        report(error);
      } catch {
        /* Keep cleaning up. */
      }
    }
  };
  const install = async (subscription: Subscription, attempt: number): Promise<void> => {
    if (controller.signal.aborted) return;
    try {
      const stop = await subscription.register(controller.signal);
      if (controller.signal.aborted) {
        safely(stop);
        return;
      }
      stops.add(stop);
      if (attempt > 0 && subscription.recover) {
        // A failed snapshot retries its own read, keeping the healthy listener installed.
        const recover = async (retry: number): Promise<void> => {
          if (controller.signal.aborted) return;
          try {
            await subscription.recover!(controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (retry === 0) safely(() => report(error));
            schedule(() => {
              void recover(retry + 1);
            }, retry);
          }
        };
        void recover(0);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (attempt === 0) safely(() => report(error));
      schedule(() => {
        void install(subscription, attempt + 1);
      }, attempt);
    }
  };
  const schedule = (run: () => void, attempt: number) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        if (!controller.signal.aborted) run();
      },
      Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)),
    );
    timers.add(timer);
  };
  return {
    start(): Promise<void> {
      return (startup ??= Promise.all(subscriptions.map((item) => install(item, 0))).then(
        () => {},
      ));
    },
    dispose() {
      controller.abort();
      timers.forEach(clearTimeout);
      timers.clear();
      stops.forEach((stop) => safely(stop));
      stops.clear();
    },
  };
}
