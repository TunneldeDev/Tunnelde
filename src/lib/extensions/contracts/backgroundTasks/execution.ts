import type { FrontendTaskProgress } from "./entry.js";

export interface FrontendBackgroundTaskOptions {
  title: string;
  /** Defaults to true. Hidden JS work still keeps its WebView alive. */
  visible?: boolean;
  cancellable?: boolean;
  signal?: AbortSignal;
}
export interface FrontendBackgroundTaskContext {
  readonly signal: AbortSignal;
  /** Reports immutable copies. Rejects reports after settlement, cancellation or runtime revocation. */
  report(update: { message?: string; progress?: FrontendTaskProgress }): void;
}
export interface FrontendBackgroundTaskRunner {
  /** Wrap this plugin's cooperative work, at most eight pending operations per runtime.
   * No arbitrary execution permission is granted. Work owns its actual effects.
   * Cancellation signals intent; settlement occurs only when work resolves or rejects.
   */
  run<T>(
    options: FrontendBackgroundTaskOptions,
    work: (context: FrontendBackgroundTaskContext) => T | Promise<T>,
  ): Promise<T>;
}
