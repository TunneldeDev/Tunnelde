import type { ResourceOperationOptions } from "./contracts";
import type { ScopeReservation } from "./reservation";
import { ResourceScopeClosed, ResourceScopeError } from "./errors";
import { validateScopeSignal } from "./signals";

export function runOperation<T>(
  owner: AbortSignal,
  reserve: () => ScopeReservation,
  start: (signal: AbortSignal) => T | Promise<T>,
  cleanup: (value: T) => void | Promise<void>,
  retain: boolean,
  { signal, timeoutMs }: ResourceOperationOptions = {},
): Promise<T> {
  if (typeof start !== "function")
    return Promise.reject(new TypeError("extension.scope.invalidOperation"));
  if (typeof cleanup !== "function")
    return Promise.reject(new TypeError("extension.scope.invalidCleanup"));
  try {
    validateScopeSignal(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
  )
    return Promise.reject(new RangeError("extension.scope.invalidTimeout"));
  if (owner.aborted) return Promise.reject(new ResourceScopeClosed());
  if (signal?.aborted) return Promise.reject(new ResourceScopeError("extension.scope.cancelled"));
  if (timeoutMs === 0) return Promise.reject(new ResourceScopeError("extension.scope.timeout"));
  let entry: ScopeReservation;
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
      owner.removeEventListener("abort", stop);
      try {
        signal?.removeEventListener("abort", cancel);
      } catch {
        /* A malformed plugin signal must not retain a reservation. */
      }
      if (timer !== undefined) clearTimeout(timer);
    };
    const fail = (error: ResourceScopeError) => {
      if (finished) return;
      finished = cancelled = true;
      detach();
      work.abort(error);
      reject(error);
    };
    const stop = () => fail(new ResourceScopeClosed());
    const cancel = () => fail(new ResourceScopeError("extension.scope.cancelled"));
    const accepted = (value: T) => {
      entry.attach(() => {
        work.abort(new ResourceScopeClosed());
        return cleanup(value);
      });
      if (cancelled || owner.aborted || !retain) entry.stop();
      if (finished) return;
      finished = true;
      detach();
      resolve(value);
    };
    const rejected = (error: unknown) => {
      entry.fail();
      if (finished) return;
      finished = true;
      detach();
      work.abort(error);
      reject(error);
    };
    try {
      owner.addEventListener("abort", stop, { once: true });
      signal?.addEventListener("abort", cancel, { once: true });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => fail(new ResourceScopeError("extension.scope.timeout")), timeoutMs);
      Promise.resolve(start(work.signal)).then(accepted, rejected).catch(rejected);
    } catch (error) {
      rejected(error);
    }
  });
}
