import type { RemoteProcess } from "@/lib/api/types";
import type {
  FrontendProcesses,
  FrontendProcessesSnapshot,
} from "../../contracts/monitor/processes/provider";
import { processColumns, processIdentity } from "@/lib/monitor/processes/model";
import { projectProcesses } from "./projection";

export interface ProcessActions {
  validate(): boolean;
  setQuery: FrontendProcesses["setQuery"];
  setSort: FrontendProcesses["setSort"];
  select(process: RemoteProcess | null): void;
  refresh(): void;
  setPaused(paused: boolean): void;
  requestTerminate(process: RemoteProcess, authorize: () => void): void;
}
export type ProcessesContext = Omit<
  FrontendProcesses,
  "Entries" | "capabilities" | "requestTerminate"
> & {
  requestTerminate(request: { revision: string; key: string }, authorize: () => void): void;
};

export function createProcessesContext(
  snapshot: Omit<FrontendProcessesSnapshot, "total" | "selectedKey">,
  items: readonly RemoteProcess[],
  selected: RemoteProcess | undefined,
  actions: ProcessActions,
): ProcessesContext {
  const rows = projectProcesses(items);
  const byKey = new Map(rows.map((row, index) => [row.key, { row, process: items[index]! }]));
  const selectedIndex = selected
    ? items.findIndex((item) => processIdentity(item) === processIdentity(selected))
    : -1;
  const data = Object.freeze({
    sessionId: snapshot.sessionId,
    hostId: snapshot.hostId,
    title: snapshot.title,
    revision: snapshot.revision,
    query: snapshot.query,
    busy: snapshot.busy,
    stopping: snapshot.stopping,
    paused: snapshot.paused,
    updatedAt: snapshot.updatedAt,
    error: snapshot.error,
    sort: Object.freeze({ ...snapshot.sort }),
    total: rows.length,
    selectedKey: selectedIndex < 0 ? null : rows[selectedIndex]!.key,
  });
  const ready = () => {
    if (!actions.validate()) throw new Error("plugin.processes.changed");
  };
  const entry = (request: { revision: string; key: string }) => {
    ready();
    if (!request || typeof request !== "object" || typeof request.key !== "string")
      throw new Error("plugin.processes.invalid");
    if (request.revision !== data.revision) throw new Error("plugin.processes.changed");
    const value = byKey.get(request.key);
    if (!value) throw new Error("plugin.processes.invalid");
    return value;
  };
  return Object.freeze<ProcessesContext>({
    snapshot: data,
    read(request) {
      if (!request || typeof request !== "object") throw new Error("plugin.processes.invalid");
      if (request.revision !== data.revision) throw new Error("plugin.processes.changed");
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
        throw new Error("plugin.processes.invalid");
      const page = [];
      let next = offset,
        size = 2;
      for (; next < rows.length && page.length < 128; next++) {
        const row = rows[next]!,
          length = JSON.stringify(row).length + (page.length ? 1 : 0);
        if (size + length > 65536) break;
        size += length;
        page.push(row);
      }
      return Object.freeze({
        revision: data.revision,
        total: rows.length,
        nextOffset: next < rows.length ? next : null,
        items: Object.freeze(page),
      });
    },
    setQuery(query) {
      ready();
      if (typeof query !== "string" || query.length > 4096)
        throw new Error("plugin.processes.invalid");
      actions.setQuery(query);
    },
    setSort(sort) {
      ready();
      if (!sort || !processColumns.includes(sort.key) || typeof sort.descending !== "boolean")
        throw new Error("plugin.processes.invalid");
      actions.setSort({ key: sort.key, descending: sort.descending });
    },
    select(request) {
      if (request?.key === null) {
        ready();
        if (request.revision !== data.revision) throw new Error("plugin.processes.changed");
        actions.select(null);
      } else actions.select(entry(request as { revision: string; key: string }).process);
    },
    refresh() {
      ready();
      actions.refresh();
    },
    setPaused(paused) {
      ready();
      if (typeof paused !== "boolean") throw new Error("plugin.processes.invalid");
      actions.setPaused(paused);
    },
    requestTerminate(request, authorize) {
      const value = entry(request);
      if (!value.row.terminable || data.stopping) throw new Error("plugin.processes.unavailable");
      actions.requestTerminate(value.process, authorize);
    },
  });
}
