import type { PluginLogLevel } from "./entry.js";

export type PluginLogSource = "diagnostics" | "operations";
export interface PluginLogFilter {
  /** Exact OR within each field; AND between fields. */
  domains?: string[];
  plugins?: string[];
  levels?: PluginLogLevel[];
  /** Case-insensitive plain text over the projected record; at most 256 UTF-8 bytes. */
  text?: string;
}
export interface PluginLogReadRequest {
  source?: PluginLogSource;
  /** Opaque position bound to process, runtime, source and normalized filter. */
  cursor?: string;
  filter?: PluginLogFilter;
  /** 1..200, default 100. Response size may end a page earlier. */
  limit?: number;
}
