import type { ProfileMetadata } from "../metadata.js";

/** Content revision is opaque and distinct from profiles.observe's metadata token.
 * activeId records explicit selection, not equality with current preferences;
 * selection changes alone do not change this content revision.
 */
export interface ProfilesCatalogue {
  readonly version: 1;
  readonly revision: string;
  readonly activeId: string | null;
  readonly items: readonly ProfileMetadata[];
}
