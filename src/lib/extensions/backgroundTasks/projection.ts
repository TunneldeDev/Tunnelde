import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import type { FrontendBackgroundTaskEntry } from "../contracts/backgroundTasks/entry";

const text = (value: string | undefined, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : null;
const nonnegative = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function projectBackgroundTasks(originals: readonly BackgroundTaskEntry[]) {
  return Object.freeze(
    originals.map((entry, index): Readonly<FrontendBackgroundTaskEntry> => {
      const row = {
        key: `task:${index}`,
        source: text(entry.source, 100)!,
        pluginId: text(entry.pluginId, 100),
        id: text(entry.id, 512)!,
        title: text(entry.title, 512)!,
        status: entry.status,
        execution: entry.execution,
        updatedAt: nonnegative(entry.updatedAt) ?? 0,
        message: text(entry.message, 4096),
        error: text(entry.error, 4096),
        progress:
          entry.progress && nonnegative(entry.progress.completed) !== null
            ? Object.freeze({
                completed: entry.progress.completed,
                total: nonnegative(entry.progress.total),
                unit: entry.progress.unit,
              })
            : null,
        actions: (entry.actions ?? [])
          .filter((action) => action.id.length <= 128)
          .slice(0, 16)
          .map((action) =>
            Object.freeze({
              id: action.id,
              label: text(action.label, 256)!,
              disabled: !!action.disabled,
            }),
          ),
      };
      // JSON escaping can expand otherwise bounded text sixfold. Omit excess
      // descriptors rather than strand pagination on an unreadable oversized row.
      while (JSON.stringify(row).length > 65534 && row.actions.length) row.actions.pop();
      return Object.freeze({ ...row, actions: Object.freeze(row.actions) });
    }),
  );
}
