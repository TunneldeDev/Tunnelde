import type { EditorBufferMetadata } from "./identity.js";

export interface EditorBufferObservationRequest {
  /** Omit to observe the active tab; a specified tab is independent of selection. */
  readonly tabId?: string;
  /** Opaque 1-128 UTF-8 byte token without control characters. */
  readonly revision?: string;
}

/** Latest captured state; intermediate changes may coalesce. */
export type EditorBufferObservation =
  | {
      readonly schemaVersion: 1;
      readonly revision: string;
      readonly changed: false;
      readonly snapshot?: never;
    }
  | {
      readonly schemaVersion: 1;
      readonly revision: string;
      readonly changed: true;
      readonly snapshot: EditorBufferMetadata | null;
    };
