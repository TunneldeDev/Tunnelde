import type { WindowProviderOwner } from "./windowProviderSource";
import { translateError } from "@/lib/api/errors";
import { usePanelWindows } from "@/store/panelWindows";
import { windowViews } from "./windowViews";
import { createContext, useContext, type ReactNode } from "react";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import { useBackgroundTasks, runBackgroundTaskAction } from "@/lib/tasks/registry";
import { clearFinishedBackgroundTasks } from "@/lib/tasks/actions";
import type { TaskViewEntry } from "./taskProjection";
import type { TransferWindowAction } from "@/features/sftp/transferWindowProtocol";
import { useTaskProjection } from "./taskProjection";
export interface ClearTasksResult {
  count: number;
  first?: string;
}
export interface TransferPanelModel {
  entries: readonly TaskViewEntry[];
  action: <T>(request: TransferWindowAction) => Promise<T>;
}
export interface TaskPanelModel {
  providerOwner?: WindowProviderOwner;
  transfers?: TransferPanelModel;
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
  const available = usePanelWindows((s) => s.available);
  const transferAction = <T,>(request: TransferWindowAction): Promise<T> => {
    const state = usePanelWindows.getState(),
      client = windowViews()?.client;
    const lease = state.snapshot.panels.find(
      (p) => p.panelId === "tasks" && p.windowId === state.windowId,
    );
    if (!client || !lease) return Promise.reject(new Error("panel.window.staleOwner"));
    return client.action<T>(lease, request);
  };
  return (
    remote ?? {
      items,
      ...(available ? { transfers: { entries: projected, action: transferAction } } : {}),
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
