interface ScheduledJob<T> {
  task: () => Promise<T>;
  resolve: (value: T | null) => void;
  signal?: AbortSignal;
  cancelled: boolean;
}

interface SchedulerState<T> {
  active: ScheduledJob<T> | null;
  latest: ScheduledJob<T> | null;
}

const states = new Map<string, SchedulerState<unknown>>();

function stateFor<T>(key: string): SchedulerState<T> {
  let state = states.get(key) as SchedulerState<T> | undefined;
  if (!state) {
    state = { active: null, latest: null };
    states.set(key, state as SchedulerState<unknown>);
  }
  return state;
}

function startNext<T>(key: string, state: SchedulerState<T>) {
  if (state.active) return;
  const job = state.latest;
  state.latest = null;
  if (!job) {
    if (states.get(key) === (state as SchedulerState<unknown>)) states.delete(key);
    return;
  }
  state.active = job;
  void job
    .task()
    .then(
      (value) => {
        if (!job.cancelled) job.resolve(value);
      },
      () => {
        if (!job.cancelled) job.resolve(null);
      },
    )
    .finally(() => {
      state.active = null;
      startNext(key, state);
    });
}

/**
 * Automatic syntax calls are coalesced per provider/runtime. There is at most
 * one real IPC invocation active; newer requests replace the single queued
 * request. Aborting a caller fences delivery but does not release the active
 * slot until the underlying IPC actually settles.
 */
export function scheduleLatestSyntaxCall<T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const state = stateFor<T>(key);
    const job: ScheduledJob<T> = { task, resolve, signal, cancelled: false };
    if (state.active) {
      state.latest?.resolve(null);
      state.latest = job;
    } else {
      state.latest = job;
      startNext(key, state);
    }
    signal?.addEventListener(
      "abort",
      () => {
        job.cancelled = true;
        if (state.latest === job) state.latest = null;
        resolve(null);
      },
      { once: true },
    );
  });
}

/** Test/diagnostic visibility without exposing provider data. */
export function pendingSyntaxCalls(key?: string): number {
  if (key) {
    const state = states.get(key);
    return Number(!!state?.active) + Number(!!state?.latest);
  }
  return [...states.values()].reduce(
    (count, state) => count + Number(!!state.active) + Number(!!state.latest),
    0,
  );
}
