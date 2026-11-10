/** Public experimental UI SDK. Execution ownership remains with the source feature. */
export interface FrontendBackgroundTaskEntry {
  /** Opaque identity scoped to this snapshot revision. */
  key: string;
  source: string;
  /** Host-assigned owner for plugin work; null for application tasks. */
  pluginId: string | null;
  id: string;
  title: string;
  status: "running" | "paused" | "attention" | "done" | "cancelled";
  updatedAt: number;
  execution: "native" | "webview";
  progress: Readonly<FrontendTaskProgress> | null;
  message: string | null;
  error: string | null;
  actions: readonly Readonly<{ id: string; label: string; disabled: boolean }>[];
}

export interface FrontendTaskProgress {
  completed: number;
  total?: number | null;
  unit?: "bytes" | "items" | "percent";
}
