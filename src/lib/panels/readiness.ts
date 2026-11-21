import { awaitPanelWork } from "./viewCapture";

/** A committed renderer's asynchronous admission, not a timer or a rendered
 * loading shell. Invalidations cannot turn an old wait into replacement consent. */
export function createPanelReadiness() {
  let state: { ready: boolean; error?: unknown } = { ready: false };
  let disposed = false;
  const pending = new Set<{ resolve(): void; reject(error: unknown): void }>();
  const check = () => {
    if (disposed) throw new Error("panel.window.cancelled");
    if (state.error !== undefined) throw state.error;
    if (!state.ready) throw new Error("panel.window.viewNotReady");
  };
  const wait = (signal: AbortSignal) => {
    if (disposed || signal.aborted) return Promise.reject(new Error("panel.window.cancelled"));
    if (state.error !== undefined) return Promise.reject(state.error);
    if (state.ready) return Promise.resolve();
    let waiter!: { resolve(): void; reject(error: unknown): void };
    const work = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      pending.add(waiter);
    });
    return awaitPanelWork(work, signal).finally(() => pending.delete(waiter));
  };
  return {
    check,
    wait,
    commit(ready: boolean, error?: unknown) {
      if (disposed) return;
      state = { ready, error };
      if (!ready && error === undefined) return;
      for (const waiter of pending) {
        if (error !== undefined) waiter.reject(error);
        else waiter.resolve();
      }
      pending.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const waiter of pending) waiter.reject(new Error("panel.window.cancelled"));
      pending.clear();
    },
  };
}
