/** Public experimental UI SDK 0.1.0 contract. */

export interface UiResourceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface UiResourceScope {
  readonly signal: AbortSignal;
  readonly size: number;
  use(cleanup: () => void | Promise<void>): () => void;
  acquire<T>(
    start: (signal: AbortSignal) => T | Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
    options?: UiResourceOptions,
  ): Promise<T>;
  run<T>(start: (signal: AbortSignal) => T | Promise<T>, options?: UiResourceOptions): Promise<T>;
  /** Abort and initiate cleanup. Cannot forcibly interrupt trusted JavaScript. */
  dispose(): void;
}
