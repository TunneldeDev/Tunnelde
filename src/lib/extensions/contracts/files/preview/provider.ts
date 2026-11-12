import type * as React from "react";
import type { FilePreviewMetadata, FilePreviewProviderPage } from "./data.js";

/** Experimental, scoped to one committed host preview and selected provider generation. */
export interface FrontendFilePreview {
  /** Optional: mount once to reuse the live host renderer without remounting it. */
  readonly Body: React.ComponentType;
  readonly snapshot: FilePreviewMetadata;
  readProviders(request: {
    revision: string;
    offset?: number;
    limit?: number;
  }): FilePreviewProviderPage;
  /** Actions require filePreview.write and reject retained/stale contexts. */
  close(): void;
  retry(): void;
  /** Move the existing renderer without opening a second file resource. */
  dock(): void;
  undock(): void;
  selectProvider(providerId: string): void;
}
