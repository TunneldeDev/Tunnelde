/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { FrontendMonitorSample } from "./sample.js";
import type { FrontendMonitorReading } from "./reading.js";

export interface FrontendMonitorSnapshot {
  sessionId: string;
  hostId: string;
  title: string;
  revision: string;
  /** The same provider can render both the compact inspector and full monitor page. */
  presentation: "page" | "panel";
  latest: Readonly<FrontendMonitorReading> | null;
  /** At most 240 samples, oldest first. Unknown metrics remain null. */
  total: number;
  /** Whether this page owns sampling. Hidden application windows temporarily suspend it. */
  sampling: boolean;
  busy: boolean;
  error: string | null;
}
export interface FrontendMonitor {
  /** Optional: mount once to reuse native charts. Sampling belongs to the host page. */
  readonly Charts: React.ComponentType;
  readonly snapshot: Readonly<FrontendMonitorSnapshot>;
  /** Up to 128 immutable points per revision-bound page. */
  read(request: { revision: string; offset?: number }): {
    revision: string;
    total: number;
    nextOffset: number | null;
    items: readonly Readonly<FrontendMonitorSample>[];
  };
  /** Coalesces with the existing host sample. Requires the current visible page/revision.
   * Completion and errors appear in new snapshots. Does not start a separate poller.
   */
  refresh(): void;
}
