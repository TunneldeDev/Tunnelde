import type { ProfilesSnapshot } from "./snapshot.js";

export interface ProfilesObservationRequest {
  /** Omit for initial metadata. 1-128 UTF-8 bytes without control characters. */
  revision?: string;
}

export type ProfilesObservation =
  | { readonly version: 1; readonly revision: string; readonly changed: false }
  | {
      readonly version: 1;
      readonly revision: string;
      readonly changed: true;
      readonly snapshot: ProfilesSnapshot;
    };
