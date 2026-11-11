import type {
  HostStorageLocation,
  HostStoragePlanChange,
  HostStorageCategory,
} from "../locations/location.js";

/** Persisted metadata only. Recorded paths confer no deletion or ownership authority. */
export interface HostStorageRecoverySnapshot {
  readonly version: 1;
  readonly revision: string;
  readonly locations: readonly HostStorageLocation[];
  readonly pending: {
    readonly action: "apply" | "cancel";
    readonly restartRequested: boolean;
    readonly changes: readonly HostStoragePlanChange[];
  } | null;
  /** Ordered by category, then previous/archive. At most one path per kind/category. */
  readonly recordedCopies: readonly {
    readonly category: HostStorageCategory;
    readonly kind: "previous" | "archive";
    readonly path: string;
  }[];
  readonly hasError: boolean;
}
