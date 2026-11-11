//! Host page identity is separate from the durable preference revision.
import type { FrontendPreferencesSnapshot } from "../contracts/preferences/provider";

export interface PreferencesContext {
  readonly snapshot: FrontendPreferencesSnapshot;
  /** Every call requires the current committed frame; mutations also require visibility. */
  validate(mutation: boolean): boolean;
}
