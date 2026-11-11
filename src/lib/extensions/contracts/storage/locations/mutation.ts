import type { HostStoragePlanChange } from "./location.js";
import type { HostStorageSnapshot } from "./snapshot.js";

export interface HostStorageScheduleRequest {
  readonly revision: string;
  readonly changes: readonly HostStoragePlanChange[];
}
export interface HostStorageCancelRequest {
  readonly revision: string;
}
/** Native confirmation is required. Scheduling does not restart or migrate. */
export interface HostStorageChangeResult {
  readonly version: 1;
  readonly outcome: "scheduled" | "cancelled" | "dismissed";
  readonly snapshot: HostStorageSnapshot;
}
