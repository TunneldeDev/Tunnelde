/** Experimental preview metadata. Native tickets, URLs and contents remain private. */
export type FilePreviewSource = Readonly<{ kind: "local" } | { kind: "remote"; sessionId: string }>;
export type FilePreviewRenderer = "text" | "markdown" | "image" | "audio" | "video" | "pdf";
export type FilePreviewState = "loading" | "ready" | "error" | "unavailable";
export type FilePreviewError = "readFailed" | "decodeFailed" | "rendererUnavailable";

export interface FilePreviewMetadata {
  readonly id: string;
  readonly revision: string;
  readonly attemptId: string;
  readonly source: FilePreviewSource;
  readonly path: string;
  /** Zero means unspecified; positive host coordinates are one-based. */
  readonly line: number;
  readonly column: number;
  /** Current host quick-look dialog; does not imply a docked workspace panel. */
  readonly presentation: "quickLook";
  readonly renderer: FilePreviewRenderer;
  readonly providerId: string | null;
  readonly providerCount: number;
  readonly state: FilePreviewState;
  readonly errorCode: FilePreviewError | null;
}
export interface FilePreviewObservationRequest {
  readonly revision?: string;
}
export type FilePreviewObservation =
  | { readonly schemaVersion: 1; readonly revision: string; readonly changed: false }
  | {
      readonly schemaVersion: 1;
      readonly revision: string;
      readonly changed: true;
      readonly snapshot: FilePreviewMetadata | null;
    };
export interface FilePreviewProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly renderer: FilePreviewRenderer;
}
export interface FilePreviewProvidersRequest {
  readonly id: string;
  readonly revision: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface FilePreviewProviderPage {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: string;
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly items: readonly FilePreviewProviderEntry[];
}
