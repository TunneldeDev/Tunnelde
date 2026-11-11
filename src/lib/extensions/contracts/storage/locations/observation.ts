import type { HostStorageSnapshot } from "./snapshot.js";

export interface HostStorageObserveRequest {
  readonly revision?: string;
}
/** Latest state, not a per-change event log. Revision is opaque. */
export type HostStorageObservation =
  | { readonly version: 1; readonly revision: string; readonly changed: false }
  | {
      readonly version: 1;
      readonly revision: string;
      readonly changed: true;
      readonly snapshot: HostStorageSnapshot;
    };
