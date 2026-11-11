import type { ResourceCleanup } from "./contracts";

export interface ScopeReservation {
  stop(): void;
  attach(cleanup: ResourceCleanup): void;
  /** Failed acquisition has settled without producing a resource. */
  fail(): void;
}

/** Cancellation is a request; only settlement releases its budget. */
export function createReservation(
  complete: () => void,
  report: (error: unknown) => void,
): ScopeReservation {
  let stopped = false;
  let settled = false;
  let cleanup: ResourceCleanup | undefined;
  const finish = () => {
    if (settled) return;
    settled = true;
    complete();
  };
  const release = () => {
    const action = cleanup;
    cleanup = undefined;
    if (!action || settled) return;
    try {
      const result = action();
      if (result) void Promise.resolve(result).catch(report).finally(finish);
      else finish();
    } catch (error) {
      report(error);
      finish();
    }
  };
  return {
    stop() {
      if (stopped || settled) return;
      stopped = true;
      release();
    },
    attach(value) {
      cleanup = value;
      if (stopped) release();
    },
    fail: finish,
  };
}
