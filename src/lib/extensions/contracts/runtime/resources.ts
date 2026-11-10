/** Public experimental UI SDK 0.1.0 contract. */

export interface UiResourceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface UiChildResourceOptions {
  signal?: AbortSignal;
  /** Additional local cap; cannot exceed this scope's cap or bypass ancestor limits. */
  limit?: number;
}
export interface UiResourceScope {
  readonly signal: AbortSignal;
  /** Subtree reservations, including open children, unsettled work and async cleanup. */
  readonly size: number;
  use(cleanup: () => void | Promise<void>): () => void;
  acquire<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
    options?: UiResourceOptions,
  ): Promise<T>;
  run<T>(start: (signal: AbortSignal) => T | Promise<T>, options?: UiResourceOptions): Promise<T>;
  /** Experimental capability; check frontend.resourceScopes or this member on older hosts.
   * Create inside a committed effect and dispose in its cleanup. Hiding is not closing.
   */
  child?(options?: UiChildResourceOptions): UiResourceScope;
  /** Abort and initiate cleanup. Cannot forcibly interrupt trusted JavaScript. */
  dispose(): void;
}
