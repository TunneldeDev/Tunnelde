import type { PluginStorageJson } from "./json.js";

/** Only the calling plugin's KV map; never host locations or keyring secrets. */
export interface PluginStorageSnapshot {
  readonly version: 1;
  readonly revision: string;
  readonly values: Readonly<Record<string, PluginStorageJson>>;
}
