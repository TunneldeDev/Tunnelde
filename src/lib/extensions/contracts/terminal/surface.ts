/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

export interface FrontendTerminalSnapshot {
  sessionId: string;
  hostId: string | null;
  title: string;
  status: "starting" | "ready" | "suspended" | "closed";
  /** Changes whenever parsed output, scrolling, selection, geometry or status changes. */
  revision: number;
  cols: number;
  rows: number;
  buffer: "normal" | "alternate";
  totalLines: number;
  viewportY: number;
}
export interface FrontendTerminalChange {
  revision: number;
  changes: readonly ("output" | "selection" | "scroll" | "resize" | "status")[];
}
export interface FrontendTerminal {
  /** Required: mount exactly once. Moves the live host terminal without recreating its PTY. */
  readonly Screen: React.ComponentType;
  readState(): Readonly<FrontendTerminalSnapshot>;
  /** Read parsed buffer text, never raw control strings. At most 128 rows / 65536 UTF-16
   * units per page, with at most 4096 units per row. A truncated row is explicitly marked.
   * Omit offset to start at the current viewport. Pass revision for consistent pagination.
   */
  readLines(request?: { revision?: number; offset?: number }): {
    revision: number;
    offset: number;
    total: number;
    nextOffset: number | null;
    lines: readonly Readonly<{ row: number; text: string; wrapped: boolean; truncated: boolean }>[];
  };
  /** Dirty notifications, coalesced over 100ms, not a lossless output stream.
   * Re-read the snapshot after each notification. At most 16 subscriptions per terminal.
   * Host revocation, provider replacement and unmount remove subscriptions automatically.
   */
  subscribe(
    receive: (change: Readonly<FrontendTerminalChange>) => void,
    options?: { signal?: AbortSignal },
  ): () => void;
  /** At most 65536 UTF-16 units, with an explicit truncation flag. No system clipboard read. */
  readSelection(): Readonly<{ text: string; truncated: boolean }>;
  focus(): void;
  /** Same negotiated paste path as the host, at most 65536 UTF-16 units. */
  paste(text: string): void;
  /** Raw UTF-8 terminal input (including shell commands), not a shell execution result. */
  send(text: string): void;
  scrollToLine(row: number): void;
  clearSelection(): void;
}
