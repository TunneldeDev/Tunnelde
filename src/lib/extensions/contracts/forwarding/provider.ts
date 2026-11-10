/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { FrontendForwardingEntry } from "./entry.js";

export interface FrontendForwardingSnapshot {
  hostId: string;
  title: string;
  revision: string;
  total: number;
  connected: boolean;
  busy: boolean;
  editing: boolean;
  error: string | null;
}
export interface FrontendForwarding {
  /** Optional: mount once to compose native rows. Host editors and confirmations remain live. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendForwardingSnapshot>;
  readonly capabilities: Readonly<{ write: boolean }>;
  /** At most 128 entries and 65536 UTF-16 text units per page. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendForwardingEntry>[];
  };
  refresh(): void;
  /** All actions below require forwards.write; actions never accept arbitrary endpoints.
   * The host presents credential, trust, exposure and destructive confirmations.
   * Completion/errors appear in the next snapshot. A stale view cannot act on new rules.
   */
  start(id: string): void;
  startAll(): void;
  stop(id: string): void;
  requestAdd(): void;
  requestEdit(id: string): void;
  requestRemove(id: string): void;
  requestDisconnect(): void;
}
