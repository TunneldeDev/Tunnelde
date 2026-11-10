import type * as React from "react";
import type { FrontendBackgroundTaskEntry } from "./entry.js";

export interface FrontendBackgroundTasksSnapshot {
  revision: string;
  presentation: "floating" | "embedded";
  total: number;
  running: number;
  paused: number;
  attention: number;
  finished: number;
}
export interface FrontendBackgroundTasks {
  /** Optional, at most once. Retains native feature details, controls and confirmations. */
  readonly Entries: React.ComponentType;
  readonly snapshot: Readonly<FrontendBackgroundTasksSnapshot>;
  readonly capabilities: Readonly<{ actions: boolean }>;
  /** Visible tasks only; at most 128 entries and 64 Ki UTF-16 units per page. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendBackgroundTaskEntry>[];
  };
  /** Requires backgroundTasks.write and a current, visible frame. Original feature
   * confirmations and validation still apply. Unsupported/disabled actions reject.
   */
  runAction(request: { revision: string; key: string; actionId: string }): Promise<void>;
}
