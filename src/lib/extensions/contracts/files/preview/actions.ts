import type { FilePreviewSource } from "./data.js";

export type FilePreviewAction = {
  readonly id: string;
  readonly revision: string;
} & (
  | { readonly action: "close" | "retry" | "dock" | "undock" }
  | { readonly action: "selectProvider"; readonly providerId: string }
);
/** Opening a target additionally requires fs.read or sftp.read for its explicit source. */
export interface FilePreviewOpenRequest {
  readonly source: FilePreviewSource;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}
/** Host intent was accepted. Observe subsequent rendering; do not replay automatically. */
export interface FilePreviewActionResult {
  readonly schemaVersion: 1;
  readonly accepted: true;
}
