/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { FrontendProcessEntry } from "./entry.js";
import type { FrontendProcessSort } from "./query.js";

export interface FrontendProcessesSnapshot {
  sessionId: string;
  hostId: string;
  title: string;
  revision: string;
  query: string;
  sort: Readonly<FrontendProcessSort>;
  selectedKey: string | null;
  total: number;
  busy: boolean;
  stopping: boolean;
  paused: boolean;
  updatedAt: number | null;
  error: string | null;
}
export interface FrontendProcesses {
  /** Optional, at most once. Native entries retain selection, paging and details.
   * Omitting this slot does not stop the host-owned sampler.
   */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendProcessesSnapshot>;
  readonly capabilities: Readonly<{ terminate: boolean }>;
  /** Up to 128 rows, 65536 serialized UTF-16 units per items array. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendProcessEntry>[];
  };
  /** Only @name, @pid, @user, @group, @cpu and @memory are field filters. */
  setQuery(query: string): void;
  setSort(sort: FrontendProcessSort): void;
  select(request: { revision: string; key: string | null }): void;
  refresh(): void;
  /** Pauses this consumer; another open process view may still sample the same connection. */
  setPaused(paused: boolean): void;
  /** Requires monitor.write. Requests native confirmation, with live authorization
   * and process identity checked again at confirmation. Never a direct kill API.
   */
  requestTerminate(request: { revision: string; key: string }): void;
}
