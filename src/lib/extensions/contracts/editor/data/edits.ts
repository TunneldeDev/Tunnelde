import type { EditorBufferIdentity } from "./identity.js";

/** Half-open original-buffer offsets; never split a Unicode surrogate pair. */
export interface EditorBufferEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface EditorBufferEditsRequest extends EditorBufferIdentity {
  /** At most 128, ascending, nonoverlapping, distinct start offsets. */
  readonly edits: ReadonlyArray<EditorBufferEdit>;
}

export interface EditorBufferEditsResult extends EditorBufferIdentity {
  readonly schemaVersion: 1;
  readonly dirty: boolean;
  readonly utf16Length: number;
}
