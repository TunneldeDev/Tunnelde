/** Experimental preference form presentation. Host navigation and recovery remain available. */
import type * as React from "react";
import type { PreferenceSnapshot } from "./data/snapshot.js";
import type { PreferenceSchema } from "./data/schema.js";
import type { PreferenceUpdate } from "./data/update.js";

export interface FrontendPreferenceField {
  /** Public group.field path, independent of internal setting names. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly modified: boolean;
}

export interface FrontendPreferencesSnapshot {
  /** Page identity: changes whenever visible fields, query or confirmed preferences change. */
  readonly revision: string;
  readonly section: string;
  readonly query: string;
  readonly modifiedOnly: boolean;
  readonly fields: readonly FrontendPreferenceField[];
  readonly busy: boolean;
  readonly error: string | null;
}

export interface FrontendPreferences {
  /** Optional, at most once. Retains the native preference controls and their drafts. */
  readonly Fields: React.ComponentType;
  readonly snapshot: FrontendPreferencesSnapshot;
  readonly capabilities: Readonly<{ update: boolean }>;
  /** Reads through the selected plugin's authorized RPC lease. */
  schema(): Promise<PreferenceSchema>;
  read(): Promise<PreferenceSnapshot>;
  /** Requires settings.write, a live visible page and the persistent revision from read().
   * Supplied fields replace their whole value. No implicit retry on stale revision.
   */
  update(request: PreferenceUpdate): Promise<PreferenceSnapshot>;
}
