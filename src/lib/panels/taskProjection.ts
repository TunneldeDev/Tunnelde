import { create } from "zustand";
import { useTransfers } from "@/store/transfers";
import { useSsh } from "@/store/ssh";
import { transferView, transferBinding, type TransferViewData } from "@/features/sftp/transferView";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import {
  useBackgroundTasks,
  backgroundSourceToken,
  runBackgroundTaskAction,
} from "@/lib/tasks/registry";

export interface TaskViewEntry extends Omit<BackgroundTaskEntry, "actions"> {
  ticket: string;
  transfer?: TransferViewData;
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
  const tickets = new Map<string, { token: symbol; ticket: string; binding?: string }>();
  const project = () => {
    if (projectionOwner !== owner) return;
    const items = useBackgroundTasks.getState().items.filter((task) => task.visible !== false);
    const alive = new Set(items.map((task) => task.key));
    for (const key of tickets.keys()) if (!alive.has(key)) tickets.delete(key);
    const projected: TaskViewEntry[] = [];
    for (const task of items) {
      const token = backgroundSourceToken(task.source);
      if (!token) continue;
      const transfer =
        task.source === "transfers"
          ? useTransfers.getState().items.find((item) => item.id === task.id)
          : undefined;
      const binding = transfer ? transferBinding(transfer) : undefined;
      let identity = tickets.get(task.key);
      if (!identity || identity.token !== token || identity.binding !== binding) {
        identity = { token, ticket: crypto.randomUUID(), binding };
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
        ...(transfer ? { transfer: transferView(transfer, useSsh.getState().sessions) } : {}),
        actions: (task.actions ?? []).map(({ id, label, disabled }) => ({ id, label, disabled })),
      });
    }
    useTaskProjection.setState({ items: projected });
  };
  project();
  const unsubscribe = useBackgroundTasks.subscribe(project);
  const stopTransfers = useTransfers.subscribe(project);
  const stopSsh = useSsh.subscribe(project);
  const resolve = (key: string, ticket: string) => {
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
    if (task.source === "transfers") {
      const item = useTransfers.getState().items.find((item) => item.id === task.id);
      if (!item || identity.binding !== transferBinding(item))
        throw new Error("plugin.backgroundTasks.changed");
    }
    return task;
  };
  return {
    resolve,
    async run(key: string, ticket: string, actionId: string) {
      const task = resolve(key, ticket);
      // Resolve the current published entry synchronously immediately before the
      // registry's existing source-generation/disabled/pending-action checks.
      await runBackgroundTaskAction(task, actionId);
      return null;
    },
    dispose() {
      unsubscribe();
      stopTransfers();
      stopSsh();
      tickets.clear();
      if (projectionOwner === owner) {
        projectionOwner = null;
        useTaskProjection.setState({ items: [] });
      }
    },
  };
}
