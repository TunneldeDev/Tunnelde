/** A loaded buffer lifetime and content version, not a filesystem identity. */
export interface EditorBufferIdentity {
  readonly tabId: string;
  readonly documentId: string;
  readonly version: number;
}

/** Metadata only. Offsets and lengths count UTF-16 code units. */
export interface EditorBufferMetadata extends EditorBufferIdentity {
  readonly path: string;
  readonly name: string;
  readonly utf16Length: number;
  readonly dirty: boolean;
}
