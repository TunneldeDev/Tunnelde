/** Experimental read-only resources. Byte ranges are not immutable snapshots. */
export type FileContentSource = { kind: "local" } | { kind: "remote"; sessionId: string };
export interface FileContentPrepare {
  source: FileContentSource;
  /** Absolute path on the explicitly selected endpoint. */
  path: string;
}
export interface FileContentReference {
  contentId: string;
}
export interface FileContentPrepared extends FileContentReference {
  version: 1;
  /** Descriptor expiry; preparation performs no file IO. */
  leaseMs: number;
}
export interface FileContentRead extends FileContentReference {
  offset: number;
  /** 1..49152 bytes; clamped at the opened size. */
  length: number;
}
export interface FileContentObservation extends FileContentReference {
  version: 1;
  state: "prepared" | "opening" | "open" | "closed";
  size: number | null;
  chunkBytes: 49152;
  /** Remaining idle lease; observing does not renew it. */
  leaseMs: number;
}
export interface FileContentChunk extends FileContentReference {
  version: 1;
  offset: number;
  bytes: number;
  /** Canonical base64, at most 49152 decoded bytes. */
  data: string;
  eof: boolean;
}
export interface FileContentClosed {
  version: 1;
  closed: true;
}
