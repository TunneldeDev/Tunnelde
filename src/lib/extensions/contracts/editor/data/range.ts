import type { EditorBufferIdentity } from "./identity.js";

export interface EditorBufferRangeRequest extends EditorBufferIdentity {
  readonly offset: number;
  /** 2-16384 UTF-16 code units; defaults to 16384. */
  readonly limit?: number;
}

export interface EditorBufferRange extends EditorBufferIdentity {
  readonly schemaVersion: 1;
  readonly offset: number;
  readonly totalLength: number;
  readonly text: string;
  readonly nextOffset: number | null;
}
