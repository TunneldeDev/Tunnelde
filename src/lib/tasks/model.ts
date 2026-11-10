export type BackgroundTaskStatus = "running" | "paused" | "attention" | "done" | "cancelled";

export interface TaskProgress {
  completed: number;
  total?: number | null;
  unit?: "bytes" | "items" | "percent";
}

export interface TaskAction {
  id: string;
  label: string;
  run: () => void | Promise<unknown>;
  disabled?: boolean;
}

/** Public task view model. Sources retain ownership of execution and persistence. */
export interface BackgroundTask {
  id: string;
  title: string;
  status: BackgroundTaskStatus;
  updatedAt: number;
  progress?: TaskProgress;
  message?: string;
  error?: string;
  visible?: boolean;
  execution: "native" | "webview";
  /** Host-assigned owner, never supplied by a plugin's task options. */
  pluginId?: string;
  actions?: readonly TaskAction[];
}

export interface BackgroundTaskSource {
  id: string;
  snapshot: () => readonly BackgroundTask[];
  subscribe: (changed: () => void) => () => void;
}

export interface BackgroundTaskEntry extends BackgroundTask {
  source: string;
  key: string;
}

export interface BackgroundTaskOptions {
  title: string;
  visible?: boolean;
  cancellable?: boolean;
  signal?: AbortSignal;
  pluginId?: string;
}

export interface BackgroundTaskContext {
  signal: AbortSignal;
  report: (update: { message?: string; progress?: TaskProgress }) => void;
}
