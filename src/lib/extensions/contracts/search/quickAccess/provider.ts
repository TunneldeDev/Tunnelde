/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { FrontendQuickAccessEntry } from "./entry.js";

export interface FrontendQuickAccessSnapshot {
  revision: string;
  mode: "commands" | "hosts" | "files" | "content";
  query: string;
  root: Readonly<{ path: string; sessionId: string | null }> | null;
  selectedKey: string | null;
  total: number;
  busy: boolean;
  error: string | null;
  /** File traversal has an independent result limit; read() pages collected results only. */
  limited: boolean;
  skipped: number;
}
export interface FrontendQuickAccess {
  /** Optional, at most once. Keeps native selection, icons and keyboard navigation. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendQuickAccessSnapshot>;
  readonly capabilities: Readonly<{ invoke: boolean }>;
  /** Up to 128 entries and 65536 serialized UTF-16 units per items array. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendQuickAccessEntry>[];
  };
  /** Up to 4096 UTF-16 units; field filters require @ prefixes. Does not activate plugins. */
  setQuery(query: string): void;
  select(request: { revision: string; key: string }): void;
  /** Requires workspace.write. Runs one current result through native dispatch/consent. */
  invoke(request: { revision: string; key: string }): void;
  close(): void;
}
