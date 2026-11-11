/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

/** Stored application history, not a complete shell history or terminal recording. */
export interface FrontendHistoryEntry {
  id: number;
  hostId: string;
  command: string;
  executedAt: number;
  /** Legacy oversized data is capped at 4000 UTF-16 units; it cannot be executed here. */
  truncated: boolean;
}
export interface FrontendHistorySnapshot {
  sessionId: string;
  hostId: string;
  title: string;
  revision: string;
  query: string;
  /** Entries matching the host's current query, newest first. */
  total: number;
  busy: boolean;
  error: string | null;
}
export interface FrontendHistory {
  /** Optional: mount once to compose the live native rows and their actions. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendHistorySnapshot>;
  readonly capabilities: Readonly<{ delete: boolean; clear: boolean; execute: boolean }>;
  /** At most 128 entries / 65536 UTF-16 text units, without splitting a command. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendHistoryEntry>[];
  };
  /** Same @command: / @date: syntax as the built-in search; at most 4096 UTF-16 units. */
  setQuery(query: string): void;
  refresh(): void;
  /** Existing entry in this revision; requires history.write. */
  delete(id: number): Promise<void>;
  /** Request the native confirmation dialog; requires history.write. */
  requestClear(): void;
  /** Immediately rerun an existing command in this session; requires ssh.exec.
   * Automatic recording still honors the user's Record terminal history choice.
   */
  execute(id: number): Promise<void>;
}
