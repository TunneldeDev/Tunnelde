import type { HostStorageLocation, HostStoragePlanChange } from "./location.js";

/** Global location metadata only. No inventory, secrets or native recovery IDs. */
export interface HostStorageSnapshot {
  readonly version: 1;
  readonly revision: string;
  readonly locations: readonly HostStorageLocation[];
  readonly pending: { readonly changes: readonly HostStoragePlanChange[] } | null;
  readonly recoveryRequired: boolean;
}
