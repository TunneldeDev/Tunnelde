import type { ComponentType } from "react";
import type { BackgroundTaskEntry } from "@/lib/tasks/background";

export interface TaskViewProps {
  task: BackgroundTaskEntry;
  now: number;
}

const views = new Map<string, { token: symbol; view: ComponentType<TaskViewProps> }>();
export function registerTaskPresentation(
  source: string,
  view: ComponentType<TaskViewProps>,
): () => void {
  if (views.has(source)) throw new Error(`Duplicate task presentation: ${source}`);
  const token = Symbol(source);
  views.set(source, { token, view });
  return () => {
    if (views.get(source)?.token === token) views.delete(source);
  };
}
export const taskPresentation = (source: string) => views.get(source)?.view;
