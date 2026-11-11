/** Experimental wire contracts for live host file browsers, independent of React/store state. */
export interface FileBrowserObservationRequest {
  /** Page selector, default 0/16, maximum 32 items and 64 KiB serialized UTF-8. */
  readonly offset?: number;
  readonly limit?: number;
  /** Conditional token is bound to this exact offset/limit and captured catalogue. */
  readonly revision?: string;
}

export interface FileBrowserReadRequest {
  readonly paneId: string;
  readonly revision: string;
  /** Visible listing, default 0/64, maximum 256 items and 64 KiB serialized UTF-8. */
  readonly offset?: number;
  readonly limit?: number;
}

export interface FileBrowserEntry {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly isHidden: boolean;
  readonly size: number;
  readonly modified: number | null;
  readonly permissions: number | null;
  readonly selected: boolean;
}

export interface FileBrowserMetadata {
  readonly paneId: string;
  readonly tabId: string | null;
  readonly revision: string;
  readonly source: Readonly<{ kind: "local" } | { kind: "remote"; sessionId: string }>;
  readonly path: string | null;
  readonly total: number;
  readonly selectedCount: number;
  readonly busy: boolean;
  readonly suspended: boolean;
  readonly error: string | null;
  readonly errorTruncated: boolean;
}

export interface FileBrowserCatalogue {
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly items: readonly FileBrowserMetadata[];
}

export type FileBrowserObservation =
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
      readonly snapshot: FileBrowserCatalogue;
    };

export interface FileBrowserPage {
  readonly schemaVersion: 1;
  readonly paneId: string;
  readonly revision: string;
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly items: readonly FileBrowserEntry[];
}
