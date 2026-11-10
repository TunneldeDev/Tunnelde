/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

/** Independent public file DTO; never a reference to a host store or cache. */
export interface FrontendFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}
export interface FrontendFileBrowserSnapshot {
  paneId: string;
  revision: string;
  source: Readonly<{ kind: "local" } | { kind: "remote"; sessionId: string }>;
  path: string | null;
  /** Visible entries in the host's current filter and sort order. */
  total: number;
  selectedPaths: readonly string[];
  busy: boolean;
  error: string | null;
}
export interface FrontendFileBrowser {
  /** Optional composition: mount once to reuse the live built-in file listing. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendFileBrowserSnapshot>;
  /** Pages contain at most 256 entries. Every page requires the snapshot revision. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendFileEntry>[];
  };
  /** Dispatch host navigation; completion and errors appear in a new snapshot. */
  navigate(path: string): void;
  refresh(): void;
  /** Selection is limited to the entries in this visible revision. */
  select(paths: readonly string[]): void;
  /** A directory navigates; files use the same editor/preview flow as built-in rows. */
  open(path: string, mode?: "open" | "preview"): void;
}
