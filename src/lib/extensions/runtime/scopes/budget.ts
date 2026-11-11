import { scopeLimits } from "./limits";

/** Every reservation is charged to its complete ancestor chain. */
export class ScopeBudget {
  private used = 0;
  readonly chain: readonly ScopeBudget[];

  constructor(
    readonly limit: number,
    parent?: ScopeBudget,
  ) {
    this.chain = [...(parent?.chain ?? []), this];
  }

  get size() {
    return this.used;
  }

  reserve(unownedCleanup = false): () => void {
    if (!unownedCleanup && this.chain.some((budget) => budget.used >= budget.limit))
      throw new RangeError("extension.scope.limit");
    // Already supplied resources still require cleanup even when over quota.
    // Charge that cleanup until it settles; never admit new work through it.
    for (const budget of this.chain) budget.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const budget of this.chain) budget.used--;
    };
  }
}

export function scopeLimit(limit: number, maximum: number = scopeLimits.maximumLimit): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new RangeError("extension.scope.invalidLimit");
  return limit;
}
