import type { BackgroundTask } from "./model";
import { useBackgroundTasks, backgroundSourceToken, runBackgroundTaskAction } from "./registry";

export const isFinishedTask = (task: BackgroundTask) =>
  task.status === "done" || task.status === "cancelled";

/** A source may require recovery before its record can safely be dismissed. */
export const canClearBackgroundTask = (task: BackgroundTask) =>
  task.visible !== false &&
  !["running", "paused"].includes(task.status) &&
  !!task.actions?.some((action) => action.id === "clear" && !action.disabled);

/** Clear the complete snapshot, including collapsed and paginated records. */
export async function clearFinishedBackgroundTasks(): Promise<unknown[]> {
  const pending = useBackgroundTasks
    .getState()
    .items.filter(canClearBackgroundTask)
    .map((task) => ({
      key: task.key,
      source: task.source,
      token: backgroundSourceToken(task.source),
    }));
  const errors: unknown[] = [];
  let index = 0;
  const worker = async () => {
    while (index < pending.length) {
      const entry = pending[index++]!;
      if (backgroundSourceToken(entry.source) !== entry.token) continue;
      const current = useBackgroundTasks.getState().items.find((task) => task.key === entry.key);
      if (!current || !canClearBackgroundTask(current)) continue;
      try {
        await runBackgroundTaskAction(current, "clear");
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  return errors;
}

/** Hidden JS work still requires its WebView; native-backed sources can rehydrate. */
export function backgroundTasksBlockSuspension(): boolean {
  return useBackgroundTasks
    .getState()
    .items.some(
      (task) => task.execution === "webview" && ["running", "paused"].includes(task.status),
    );
}
