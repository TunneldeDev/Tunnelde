export type ResourceCleanup = () => void | Promise<void>;

export interface ResourceOperationOptions {
  signal?: AbortSignal;
  /** Acquisition/work deadline, not the lifetime of an acquired resource. */
  timeoutMs?: number;
}

export interface ResourceChildOptions {
  signal?: AbortSignal;
  /** Additional local cap; never increases the ancestor budget. */
  limit?: number;
}

/** A host-managed JavaScript lifetime, not a sandbox or remote transaction. */
export interface ResourceScope {
  readonly signal: AbortSignal;
  /** Reservations in this subtree, including unsettled work and cleanup. */
  readonly size: number;
  use(cleanup: ResourceCleanup): () => void;
  acquire<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
    options?: ResourceOperationOptions,
  ): Promise<T>;
  run<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    options?: ResourceOperationOptions,
  ): Promise<T>;
  child(options?: ResourceChildOptions): ResourceScope;
  /** Abort and initiate LIFO cleanup; retain capacity until actual settlement. */
  dispose(): void;
}
