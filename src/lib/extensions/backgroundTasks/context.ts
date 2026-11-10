import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import { runBackgroundTaskAction } from "@/lib/tasks/registry";
import type { FrontendBackgroundTaskEntry } from "../contracts/backgroundTasks/entry";
import { projectBackgroundTasks } from "./projection";
import type {
  FrontendBackgroundTasks,
  FrontendBackgroundTasksSnapshot,
} from "../contracts/backgroundTasks/provider";

export type BackgroundTasksContext = Pick<FrontendBackgroundTasks, "snapshot" | "read"> & {
  runAction(request: { revision: string; key: string; actionId: string }): Promise<void>;
};
/** Immutable paging and final action dispatch; projection owns the public row shape. */
export function createBackgroundTasksContext(
  snapshot: Pick<FrontendBackgroundTasksSnapshot, "revision" | "presentation">,
  entries: readonly BackgroundTaskEntry[],
  validate: () => boolean,
): BackgroundTasksContext {
  const originals = entries.filter((entry) => entry.visible !== false);
  const rows = projectBackgroundTasks(originals);
  const originalByKey = new Map(originals.map((entry, index) => [`task:${index}`, entry]));
  const projectedByKey = new Map(rows.map((entry) => [entry.key, entry]));
  const data = Object.freeze({
    revision: snapshot.revision,
    presentation: snapshot.presentation,
    total: rows.length,
    running: rows.filter((row) => row.status === "running").length,
    paused: rows.filter((row) => row.status === "paused").length,
    attention: rows.filter((row) => row.status === "attention").length,
    finished: rows.filter((row) => row.status === "done" || row.status === "cancelled").length,
  });
  return Object.freeze<BackgroundTasksContext>({
    snapshot: data,
    read(request) {
      if (!request || typeof request !== "object")
        throw new Error("plugin.backgroundTasks.invalid");
      if (request.revision !== data.revision) throw new Error("plugin.backgroundTasks.changed");
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
        throw new Error("plugin.backgroundTasks.invalid");
      const items: Readonly<FrontendBackgroundTaskEntry>[] = [];
      let next = offset,
        size = 2; // JSON array brackets; include separators in the public page budget.
      for (; next < rows.length && items.length < 128; next++) {
        const row = rows[next]!,
          length = JSON.stringify(row).length + (items.length ? 1 : 0);
        if (size + length > 65536) break;
        size += length;
        items.push(row);
      }
      if (next === offset && next < rows.length) throw new Error("plugin.backgroundTasks.invalid");
      return Object.freeze({
        revision: data.revision,
        total: rows.length,
        nextOffset: next < rows.length ? next : null,
        items: Object.freeze(items),
      });
    },
    async runAction(request) {
      if (!validate()) throw new Error("plugin.backgroundTasks.changed");
      if (
        !request ||
        typeof request !== "object" ||
        typeof request.key !== "string" ||
        typeof request.actionId !== "string"
      )
        throw new Error("plugin.backgroundTasks.invalid");
      if (request.revision !== data.revision) throw new Error("plugin.backgroundTasks.changed");
      const entry = originalByKey.get(request.key);
      const action = projectedByKey
        .get(request.key)
        ?.actions.find((item) => item.id === request.actionId);
      if (!entry || !action || action.disabled)
        throw new Error("plugin.backgroundTasks.actionUnavailable");
      await runBackgroundTaskAction(entry, request.actionId);
    },
  });
}
