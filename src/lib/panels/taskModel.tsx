import { translateError } from "@/lib/api/errors";
import { usePanelWindows } from "@/store/panelWindows";
import { windowViews } from "./windowViews";
import { createContext, useContext, type ReactNode } from "react";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import { useBackgroundTasks, runBackgroundTaskAction } from "@/lib/tasks/registry";
import { clearFinishedBackgroundTasks } from "@/lib/tasks/actions";
import { useTaskProjection } from "./taskProjection";
export interface ClearTasksResult {
  count: number;
  first?: string;
}
export interface TaskPanelModel {
  items: readonly BackgroundTaskEntry[];
  viewKey: (task: BackgroundTaskEntry) => string;
  run: (task: BackgroundTaskEntry, actionId: string) => Promise<unknown>;
  clear: () => Promise<ClearTasksResult>;
}
const Context = createContext<TaskPanelModel | null>(null);
export function TaskModelScope({
  value,
  children,
}: {
  value: TaskPanelModel;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useRemoteTaskModel = () => useContext(Context);
export function useTaskPanelModel(): TaskPanelModel {
  const remote = useContext(Context);
  const items = useBackgroundTasks((s) => s.items);
  const projected = useTaskProjection((s) => s.items);
  return (
    remote ?? {
      items,
      viewKey: (task) =>
        projected.find((item) => item.key === task.key)?.ticket ?? `${task.source}:${task.id}`,
      run: (task, actionId) => {
        const state = usePanelWindows.getState(),
          client = windowViews()?.client;
        const lease = state.snapshot.panels.find(
          (panel) => panel.panelId === "tasks" && panel.windowId === state.windowId,
        );
        const entry = projected.find((item) => item.key === task.key);
        if (!state.available) return runBackgroundTaskAction(task, actionId);
        if (!client || !lease || !entry) throw new Error("panel.window.staleOwner");
        return client.action(lease, {
          kind: "task",
          key: task.key,
          ticket: entry.ticket,
          actionId,
        });
      },
      clear: async () => {
        const state = usePanelWindows.getState(),
          client = windowViews()?.client;
        const lease = state.snapshot.panels.find(
          (panel) => panel.panelId === "tasks" && panel.windowId === state.windowId,
        );
        if (state.available) {
          if (!client || !lease) throw new Error("panel.window.staleOwner");
          return client.action<ClearTasksResult>(lease, { kind: "clearTasks" });
        }
        const errors = await clearFinishedBackgroundTasks();
        return {
          count: errors.length,
          first: errors[0] === undefined ? undefined : translateError(errors[0]),
        };
      },
    }
  );
}
