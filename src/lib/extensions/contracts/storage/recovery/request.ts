import type { HostStorageRecoverySnapshot } from "./snapshot.js";
export interface HostStorageRecoveryRequest {
  readonly revision: string;
  /** Retry preserves persisted direction; cancel can never be reversed to apply. */
  readonly action: "retry" | "cancel";
}
export interface HostStorageRecoveryResult {
  readonly version: 1;
  readonly outcome: "restartScheduled" | "dismissed";
  readonly snapshot: HostStorageRecoverySnapshot;
}
