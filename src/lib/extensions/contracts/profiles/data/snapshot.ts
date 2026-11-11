import type { ProfileMetadata } from "./metadata.js";

/** At most 32 items; source order is retained. Revision is opaque, not an event cursor. */
export interface ProfilesSnapshot {
  readonly version: 1;
  readonly revision: string;
  readonly items: readonly ProfileMetadata[];
}
