import type { BackgroundTask, BackgroundTaskContext, BackgroundTaskOptions } from "./model";
import { publishManagedTasks } from "./registry";

type ManagedTask = Omit<BackgroundTask, "actions">;
const managed = new Map<string, { task: ManagedTask; controller?: AbortController }>();

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
  publishManagedTasks(items);
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
      pluginId: options.pluginId,
      visible: options.visible ?? true,
      updatedAt: Date.now(),
    } as ManagedTask,
    controller: options.cancellable === false ? undefined : controller,
  };
  managed.set(id, entry);
  publishManaged();
  const notifyAbort = () => publishManaged();
  controller.signal.addEventListener("abort", notifyAbort, { once: true });
  try {
    controller.signal.throwIfAborted();
    const result = await work({
      signal: controller.signal,
      report: (update) => {
        if (entry.task.status !== "running" || controller.signal.aborted) return;
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
    controller.signal.removeEventListener("abort", notifyAbort);
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
