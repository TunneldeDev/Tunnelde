import { create } from "zustand";

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

export const useBackgroundTasks = create<{ items: readonly BackgroundTaskEntry[] }>(() => ({
  items: [],
}));

const sources = new Map<string, { token: symbol; items: readonly BackgroundTask[] }>();
function publish() {
  useBackgroundTasks.setState({
    items: [...sources].flatMap(([source, entry]) =>
      entry.items.map((task) => ({ ...task, source, key: JSON.stringify([source, task.id]) })),
    ),
  });
}

/** Explicit registration lifetime; an old disposer can never remove a new source. */
export function registerBackgroundTaskSource(
  source: BackgroundTaskSource,
  signal?: AbortSignal,
): () => void {
  if (signal?.aborted) return () => {};
  if (
    !/^[a-z][\w.-]{0,99}$/i.test(source.id) ||
    source.id === "workbench" ||
    sources.has(source.id)
  )
    throw new Error(`Invalid or duplicate background task source: ${source.id}`);
  const token = Symbol(source.id);
  const read = () => {
    const items = source.snapshot();
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error(`Duplicate background task ID in ${source.id}`);
    return items;
  };
  sources.set(source.id, { token, items: read() });
  let stop: (() => void) | undefined;
  const dispose = () => {
    if (sources.get(source.id)?.token !== token) return;
    sources.delete(source.id);
    signal?.removeEventListener("abort", dispose);
    try {
      stop?.();
    } finally {
      publish();
    }
  };
  try {
    stop = source.subscribe(() => {
      if (sources.get(source.id)?.token !== token) return;
      sources.set(source.id, { token, items: read() });
      publish();
    });
    // Subscribe before the final snapshot to close the registration race.
    sources.set(source.id, { token, items: read() });
    signal?.addEventListener("abort", dispose, { once: true });
    if (signal?.aborted) dispose();
    else publish();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

export const isFinishedTask = (task: BackgroundTask) =>
  task.status === "done" || task.status === "cancelled";

/** Hidden JS work still requires its WebView; native-backed sources can rehydrate. */
export function backgroundTasksBlockSuspension(): boolean {
  return useBackgroundTasks
    .getState()
    .items.some(
      (task) => task.execution === "webview" && ["running", "paused"].includes(task.status),
    );
}

export interface BackgroundTaskOptions {
  title: string;
  visible?: boolean;
  cancellable?: boolean;
  signal?: AbortSignal;
}

export interface BackgroundTaskContext {
  signal: AbortSignal;
  report: (update: { message?: string; progress?: TaskProgress }) => void;
}

type ManagedTask = Omit<BackgroundTask, "actions">;
const managed = new Map<string, { task: ManagedTask; controller?: AbortController }>();
const managedToken = Symbol("workbench");

function publishManaged() {
  const completed = [...managed.values()].filter(
    (entry) => !["running", "paused"].includes(entry.task.status),
  );
  for (const entry of completed.slice(0, Math.max(0, completed.length - 100)))
    managed.delete(entry.task.id);
  const items = [...managed.values()].map(({ task, controller }) => ({
    ...task,
    actions:
      task.status === "running" && controller
        ? [
            {
              id: "cancel",
              label: "",
              disabled: controller.signal.aborted,
              run: () => {
                controller.abort();
                publishManaged();
              },
            },
          ]
        : task.status !== "running"
          ? [
              {
                id: "clear",
                label: "",
                run: () => {
                  managed.delete(task.id);
                  publishManaged();
                },
              },
            ]
          : [],
  }));
  sources.set("workbench", { token: managedToken, items });
  publish();
}

/** Wrap cooperative asynchronous work. Cancellation is complete only when work settles. */
export async function runBackgroundTask<T>(
  options: BackgroundTaskOptions,
  work: (context: BackgroundTaskContext) => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const entry = {
    task: {
      id,
      title: options.title,
      status: "running",
      execution: "webview",
      visible: options.visible ?? true,
      updatedAt: Date.now(),
    } as ManagedTask,
    controller: options.cancellable === false ? undefined : controller,
  };
  managed.set(id, entry);
  publishManaged();
  try {
    controller.signal.throwIfAborted();
    const result = await work({
      signal: controller.signal,
      report: (update) => {
        if (entry.task.status !== "running") return;
        entry.task = { ...entry.task, ...update, updatedAt: Date.now() };
        publishManaged();
      },
    });
    entry.task = { ...entry.task, status: "done", updatedAt: Date.now() };
    return result;
  } catch (error) {
    const cancelled =
      controller.signal.aborted &&
      (error === controller.signal.reason ||
        (error instanceof Error && error.name === "AbortError"));
    entry.task = {
      ...entry.task,
      status: cancelled ? "cancelled" : "attention",
      error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    };
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    entry.controller = undefined;
    if (options.visible === false) managed.delete(id);
    publishManaged();
  }
}

/** Only settled wrapper history crosses WebView recreation; in-flight JS cannot. */
export function backgroundTaskHistory(): ManagedTask[] {
  return [...managed.values()]
    .filter((entry) => !["running", "paused"].includes(entry.task.status))
    .map((entry) => entry.task);
}

export function restoreBackgroundTaskHistory(history: readonly ManagedTask[]) {
  for (const task of history) {
    if (
      typeof task.id === "string" &&
      typeof task.title === "string" &&
      ["done", "cancelled", "attention"].includes(task.status)
    )
      managed.set(task.id, { task: { ...task, execution: "webview" } });
  }
  publishManaged();
}

/** Function adapter for features that want task reporting without UI dependencies. */
export function withBackgroundTask<Args extends unknown[], Result>(
  options: BackgroundTaskOptions | ((...args: Args) => BackgroundTaskOptions),
  work: (context: BackgroundTaskContext, ...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) =>
    runBackgroundTask(typeof options === "function" ? options(...args) : options, (context) =>
      work(context, ...args),
    );
}
