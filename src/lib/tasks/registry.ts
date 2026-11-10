import { create } from "zustand";
import type { BackgroundTask, BackgroundTaskEntry, BackgroundTaskSource } from "./model";

export const useBackgroundTasks = create<{ items: readonly BackgroundTaskEntry[] }>(() => ({
  items: [],
}));

const sources = new Map<string, { token: symbol; items: readonly BackgroundTask[] }>();
const entries = new WeakMap<BackgroundTask, BackgroundTaskEntry>();
function publish() {
  useBackgroundTasks.setState({
    items: [...sources].flatMap(([source, entry]) =>
      entry.items.map((task) => {
        let published = entries.get(task);
        if (!published) {
          published = Object.freeze({ ...task, source, key: JSON.stringify([source, task.id]) });
          entries.set(task, published);
        }
        return published;
      }),
    ),
  });
}

/** Explicit registration lifetime; an old disposer can never remove a new source. */
export function registerBackgroundTaskSource(
  source: BackgroundTaskSource,
  signal?: AbortSignal,
): () => void {
  const sourceId = source.id;
  if (signal?.aborted) return () => {};
  if (!/^[a-z][\w.-]{0,99}$/i.test(sourceId) || sourceId === "workbench" || sources.has(sourceId))
    throw new Error(`Invalid or duplicate background task source: ${sourceId}`);
  const token = Symbol(sourceId);
  let closed = false;
  let stop: (() => void) | undefined;
  // Reserve identity before calling user-supplied snapshot/subscribe callbacks.
  sources.set(sourceId, { token, items: [] });
  const read = () => {
    const items = source.snapshot();
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error(`Duplicate background task ID in ${sourceId}`);
    return items.map((task) =>
      Object.freeze({
        ...task,
        progress: task.progress ? Object.freeze({ ...task.progress }) : undefined,
        actions: task.actions
          ? Object.freeze(task.actions.map((action) => Object.freeze({ ...action })))
          : undefined,
      }),
    );
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", dispose);
    if (sources.get(sourceId)?.token === token) sources.delete(sourceId);
    try {
      stop?.();
    } finally {
      publish();
    }
  };
  signal?.addEventListener("abort", dispose, { once: true });
  const refresh = () => {
    if (closed || sources.get(sourceId)?.token !== token) return;
    const items = read();
    if (closed || sources.get(sourceId)?.token !== token) return;
    sources.set(sourceId, { token, items });
    publish();
  };
  try {
    refresh();
    if (closed || signal?.aborted) {
      dispose();
      return dispose;
    }
    // Subscribe before the final snapshot to close the registration race.
    const unsubscribe = source.subscribe(refresh);
    stop = unsubscribe;
    // A synchronous callback can have disposed this source before subscribe returns.
    if (closed) {
      stop = undefined;
      unsubscribe();
      return dispose;
    }
    refresh();
    if (signal?.aborted) dispose();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

const managedToken = Symbol("workbench");
export function publishManagedTasks(items: readonly BackgroundTask[]): void {
  sources.set("workbench", {
    token: managedToken,
    items: items.map((task) =>
      Object.freeze({
        ...task,
        progress: task.progress ? Object.freeze({ ...task.progress }) : undefined,
        actions: task.actions
          ? Object.freeze(task.actions.map((action) => Object.freeze({ ...action })))
          : undefined,
      }),
    ),
  });
  publish();
}
export function backgroundSourceToken(id: string): symbol | undefined {
  return sources.get(id)?.token;
}
// Lock across progress publications, but never across replacement source generations.
const pendingActions = new Map<symbol, Set<string>>();
/** Resolve the exact published entry at the final synchronous action boundary. */
export function runBackgroundTaskAction(
  entry: BackgroundTaskEntry,
  actionId: string,
): Promise<unknown> {
  const current = useBackgroundTasks.getState().items.find((item) => item.key === entry.key);
  if (current !== entry || current.visible === false)
    throw new Error("plugin.backgroundTasks.changed");
  const action = current.actions?.find((item) => item.id === actionId);
  if (!action || action.disabled) throw new Error("plugin.backgroundTasks.actionUnavailable");
  const token = backgroundSourceToken(current.source);
  if (!token) throw new Error("plugin.backgroundTasks.changed");
  const actionKey = JSON.stringify([current.id, actionId]);
  let pending = pendingActions.get(token);
  if (!pending) {
    pending = new Set();
    pendingActions.set(token, pending);
  }
  if (pending.has(actionKey)) throw new Error("plugin.backgroundTasks.busy");
  pending.add(actionKey);
  const release = () => {
    pending.delete(actionKey);
    if (!pending.size) pendingActions.delete(token);
  };
  try {
    return Promise.resolve(action.run()).finally(release);
  } catch (error) {
    release();
    throw error;
  }
}
