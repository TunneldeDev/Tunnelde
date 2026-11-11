import type { PluginStorageSnapshot } from "./snapshot.js";

export interface PluginStorageObservationRequest {
  /** Omit for initial state; 1-128 UTF-8 bytes without control characters. */
  revision?: string;
}
export type PluginStorageObservation =
  | { readonly version: 1; readonly revision: string; readonly changed: false }
  | {
      readonly version: 1;
      readonly revision: string;
      readonly changed: true;
      readonly snapshot: PluginStorageSnapshot;
    };
