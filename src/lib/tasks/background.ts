/** Compatibility entry point; tasks own model, registry, actions and execution separately. */
export type * from "./model";
export { useBackgroundTasks, registerBackgroundTaskSource } from "./registry";
export {
  isFinishedTask,
  canClearBackgroundTask,
  clearFinishedBackgroundTasks,
  backgroundTasksBlockSuspension,
} from "./actions";
export {
  runBackgroundTask,
  withBackgroundTask,
  backgroundTaskHistory,
  restoreBackgroundTaskHistory,
} from "./execution";
