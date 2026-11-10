import type { ResourceChildOptions, ResourceScope } from "./contracts";
import { ScopeBudget, scopeLimit } from "./budget";
import { ResourceScopeClosed } from "./errors";
import { createReservation, type ScopeReservation } from "./reservation";
import { runOperation } from "./operation";
import { scopeLimits } from "./limits";
import { validateScopeSignal } from "./signals";

function createScope(
  budget: ScopeBudget,
  report: (error: unknown) => void,
  parent?: AbortSignal,
): ResourceScope {
  validateScopeSignal(parent);
  const controller = new AbortController();
  const entries = new Set<ScopeReservation>();
  const reserve = (unownedCleanup = false) => {
    if (controller.signal.aborted && !unownedCleanup) throw new ResourceScopeClosed();
    const release = budget.reserve(unownedCleanup);
    const entry = createReservation(() => {
      entries.delete(entry);
      release();
    }, report);
    entries.add(entry);
    return entry;
  };
  const dispose = () => {
    if (controller.signal.aborted) return;
    parent?.removeEventListener("abort", dispose);
    const pending = [...entries].reverse();
    controller.abort();
    for (const entry of pending) entry.stop();
  };
  parent?.addEventListener("abort", dispose, { once: true });
  if (parent?.aborted) dispose();
  return {
    signal: controller.signal,
    get size() {
      return budget.size;
    },
    use(cleanup) {
      if (typeof cleanup !== "function") throw new TypeError("extension.scope.invalidCleanup");
      let entry: ScopeReservation;
      try {
        entry = reserve();
      } catch (error) {
        entry = reserve(true);
        entry.attach(cleanup);
        entry.stop();
        if (error instanceof ResourceScopeClosed) return entry.stop;
        throw error;
      }
      entry.attach(cleanup);
      return entry.stop;
    },
    acquire: (start, cleanup, options) =>
      runOperation(controller.signal, reserve, start, cleanup, true, options),
    run: (start, options) =>
      runOperation(controller.signal, reserve, start, () => {}, false, options),
    child(options: ResourceChildOptions = {}) {
      const limit = scopeLimit(options.limit ?? budget.limit, budget.limit);
      if (budget.chain.length > scopeLimits.maximumDepth)
        throw new RangeError("extension.scope.depth");
      const entry = reserve();
      try {
        const child = createScope(new ScopeBudget(limit, budget), report, options.signal);
        entry.attach(() => child.dispose());
        child.signal.addEventListener("abort", entry.stop, { once: true });
        if (child.signal.aborted) entry.stop();
        return child;
      } catch (error) {
        entry.fail();
        throw error;
      }
    },
    dispose,
  };
}

export function createResourceScope(
  options: { parent?: AbortSignal; limit?: number; report?: (error: unknown) => void } = {},
): ResourceScope {
  const report = (error: unknown) => {
    try {
      options.report?.(error);
    } catch {
      /* Reporting cannot prevent cleanup. */
    }
  };
  return createScope(
    new ScopeBudget(scopeLimit(options.limit ?? scopeLimits.defaultLimit)),
    report,
    options.parent,
  );
}
