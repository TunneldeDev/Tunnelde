import type { PluginLogEntry } from "./entry.js";
import type { PluginLogSource } from "./query.js";

export interface PluginLogPage {
  readonly version: 1;
  readonly source: PluginLogSource;
  readonly entries: readonly PluginLogEntry[];
  readonly cursor: string;
  /** Drain serially, with a yield and backpressure; partial tails wait for appends. */
  readonly hasMore: boolean;
  /** The previous file or operations position was invalidated. */
  readonly reset: boolean;
  /** At least one record may be unavailable or was skipped as invalid/oversized. */
  readonly gap: boolean;
}
