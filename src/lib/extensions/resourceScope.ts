/** A host-managed lifetime, not a sandbox for trusted module code. */
export type ResourceCleanup = () => void | Promise<void>;

export interface ResourceOperationOptions {
  /** Cancels acquisition/work; a successfully acquired resource belongs to the scope. */
  signal?: AbortSignal;
  /** Acquisition/work deadline, not the lifetime of a successfully acquired resource. */
  timeoutMs?: number;
}

export interface ResourceScope {
  readonly signal: AbortSignal;
  readonly size: number;
  /** Own a resource; the returned function releases it early, once. */
  use(cleanup: ResourceCleanup): () => void;
  /** Reserve capacity before starting; late results are released, never delivered. */
  acquire<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
    options?: ResourceOperationOptions,
  ): Promise<T>;
  /** Run cancellable work without retaining its successfully returned value. */
  run<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    options?: ResourceOperationOptions,
  ): Promise<T>;
  /** Abort and initiate LIFO cleanup synchronously; async cleanup is observed. */
  dispose(): void;
}

export class ResourceScopeError extends Error {
  constructor(
    readonly code:
      "extension.scope.closed" | "extension.scope.cancelled" | "extension.scope.timeout",
  ) {
    super(code);
    this.name = "ResourceScopeError";
  }
}

export class ResourceScopeClosed extends ResourceScopeError {
  constructor() {
    super("extension.scope.closed");
    this.name = "ResourceScopeClosed";
  }
}

export function createResourceScope(
  options: {
    parent?: AbortSignal;
    limit?: number;
    report?: (error: unknown) => void;
  } = {},
): ResourceScope {
  const limit = options.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
    throw new RangeError("extension.scope.invalidLimit");
  const controller = new AbortController();
  const entries = new Set<() => void>();
  const pendingCleanups = new Set<Promise<void>>();
  const report = (error: unknown) => {
    try {
      options.report?.(error);
    } catch {
      /* Reporting cannot prevent cleanup. */
    }
  };
  const release = (cleanup: ResourceCleanup) => {
    try {
      const result = cleanup();
      if (result) {
        const pending = Promise.resolve(result)
          .catch(report)
          .finally(() => pendingCleanups.delete(pending));
        pendingCleanups.add(pending);
      }
    } catch (error) {
      report(error);
    }
  };
  const reserve = () => {
    if (controller.signal.aborted) throw new ResourceScopeClosed();
    if (entries.size + pendingCleanups.size >= limit) throw new RangeError("extension.scope.limit");
    let cleanup: ResourceCleanup | undefined;
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      entries.delete(stop);
      if (cleanup) release(cleanup);
    };
    entries.add(stop);
    return {
      stop,
      attach(value: ResourceCleanup) {
        if (closed || controller.signal.aborted) release(value);
        else cleanup = value;
      },
    };
  };
  const dispose = () => {
    if (controller.signal.aborted) return;
    options.parent?.removeEventListener("abort", dispose);
    // Empty first: an abort callback may release resources or register more work.
    const pending = [...entries].reverse();
    entries.clear();
    controller.abort();
    for (const stop of pending) stop();
  };
  options.parent?.addEventListener("abort", dispose, { once: true });
  if (options.parent?.aborted) dispose();
  const operate = <T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
    retain: boolean,
    operation: ResourceOperationOptions = {},
  ): Promise<T> => {
    const { signal, timeoutMs } = operation;
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
    )
      return Promise.reject(new RangeError("extension.scope.invalidTimeout"));
    if (controller.signal.aborted) return Promise.reject(new ResourceScopeClosed());
    if (signal?.aborted) return Promise.reject(new ResourceScopeError("extension.scope.cancelled"));
    if (timeoutMs === 0) return Promise.reject(new ResourceScopeError("extension.scope.timeout"));
    let entry: ReturnType<typeof reserve>;
    try {
      entry = reserve();
    } catch (error) {
      return Promise.reject(error);
    }
    const work = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const detach = () => {
        controller.signal.removeEventListener("abort", stop);
        signal?.removeEventListener("abort", cancel);
        if (timer !== undefined) clearTimeout(timer);
      };
      const fail = (error: ResourceScopeError) => {
        if (finished) return;
        finished = cancelled = true;
        detach();
        work.abort(error);
        // Keep capacity reserved until uncooperative work really settles.
        reject(error);
      };
      const stop = () => fail(new ResourceScopeClosed());
      const cancel = () => fail(new ResourceScopeError("extension.scope.cancelled"));
      controller.signal.addEventListener("abort", stop, { once: true });
      signal?.addEventListener("abort", cancel, { once: true });
      if (timeoutMs !== undefined)
        timer = setTimeout(
          () => fail(new ResourceScopeError("extension.scope.timeout")),
          timeoutMs,
        );
      const accepted = (value: T) => {
        entry.attach(() => {
          work.abort(new ResourceScopeClosed());
          return cleanup(value);
        });
        if (cancelled || controller.signal.aborted || !retain) entry.stop();
        if (finished) return;
        finished = true;
        detach();
        resolve(value);
      };
      const rejected = (error: unknown) => {
        entry.stop();
        if (finished) return;
        finished = true;
        detach();
        work.abort(error);
        reject(error);
      };
      try {
        Promise.resolve(start(work.signal)).then(accepted, rejected).catch(rejected);
      } catch (error) {
        rejected(error);
      }
    });
  };
  return {
    signal: controller.signal,
    get size() {
      return entries.size + pendingCleanups.size;
    },
    use(cleanup) {
      if (controller.signal.aborted) {
        release(cleanup);
        return () => {};
      }
      let entry;
      try {
        entry = reserve();
      } catch (error) {
        release(cleanup);
        throw error;
      }
      entry.attach(cleanup);
      return entry.stop;
    },
    acquire: (start, cleanup, operation) => operate(start, cleanup, true, operation),
    run: (start, operation) => operate(start, () => {}, false, operation),
    dispose,
  };
}
