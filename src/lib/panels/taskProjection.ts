import { create } from "zustand";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import {
  useBackgroundTasks,
  backgroundSourceToken,
  runBackgroundTaskAction,
} from "@/lib/tasks/registry";

export interface TaskViewEntry extends Omit<BackgroundTaskEntry, "actions"> {
  ticket: string;
  actions: { id: string; label: string; disabled?: boolean }[];
}
let projectionOwner: symbol | null = null;
export const useTaskProjection = create<{ items: readonly TaskViewEntry[] }>(() => ({ items: [] }));

/** Tickets identify a task/source incarnation, not a progress frame. Progress
 * updates must not make Pause unclickable; source replacement or disappearance
 * must never make an old button operate on an unrelated task with the same ID. */
export function createTaskProjection() {
  const owner = Symbol("task-projection");
  projectionOwner = owner;
  const tickets = new Map<string, { token: symbol; ticket: string }>();
  const project = () => {
    if (projectionOwner !== owner) return;
    const items = useBackgroundTasks.getState().items.filter((task) => task.visible !== false);
    const alive = new Set(items.map((task) => task.key));
    for (const key of tickets.keys()) if (!alive.has(key)) tickets.delete(key);
    const projected: TaskViewEntry[] = [];
    for (const task of items) {
      const token = backgroundSourceToken(task.source);
      if (!token) continue;
      let identity = tickets.get(task.key);
      if (!identity || identity.token !== token) {
        identity = { token, ticket: crypto.randomUUID() };
        tickets.set(task.key, identity);
      }
      const {
        id,
        key,
        source,
        title,
        status,
        updatedAt,
        execution,
        pluginId,
        progress,
        message,
        error,
      } = task;
      projected.push({
        id,
        key,
        source,
        title,
        status,
        updatedAt,
        execution,
        pluginId,
        progress,
        message,
        error,
        ticket: identity.ticket,
        actions: (task.actions ?? []).map(({ id, label, disabled }) => ({ id, label, disabled })),
      });
    }
    useTaskProjection.setState({ items: projected });
  };
  project();
  const unsubscribe = useBackgroundTasks.subscribe(project);
  return {
    async run(key: string, ticket: string, actionId: string) {
      const identity = tickets.get(key),
        task = useBackgroundTasks.getState().items.find((task) => task.key === key);
      if (
        projectionOwner !== owner ||
        !identity ||
        identity.ticket !== ticket ||
        !task ||
        task.visible === false ||
        backgroundSourceToken(task.source) !== identity.token
      )
        throw new Error("plugin.backgroundTasks.changed");
      // Resolve the current published entry synchronously immediately before the
      // registry's existing source-generation/disabled/pending-action checks.
      await runBackgroundTaskAction(task, actionId);
      return null;
    },
    dispose() {
      unsubscribe();
      tickets.clear();
      if (projectionOwner === owner) {
        projectionOwner = null;
        useTaskProjection.setState({ items: [] });
      }
    },
  };
}
