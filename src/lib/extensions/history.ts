import type {
  FrontendHistory,
  FrontendHistoryEntry,
  FrontendHistorySnapshot,
} from "./contracts/history/provider";

export interface HistoryActions {
  /** Includes immediate session/host changes, before the next React commit. */
  validate(): boolean;
  setQuery(query: string): void;
  refresh(): void;
  delete(entry: Readonly<FrontendHistoryEntry>): Promise<void>;
  requestClear(authorize: () => void): void;
  execute(entry: Readonly<FrontendHistoryEntry>): Promise<void>;
}

export type HistoryRow = Omit<FrontendHistoryEntry, "truncated">;

/** One independent revision. No internal stores, mutable rows or command injection API. */
export type HistoryContext = Omit<FrontendHistory, "Entries" | "capabilities" | "requestClear"> & {
  /** Internal confirmation continuation; the public provider only sees requestClear(). */
  requestClear(authorize: () => void): void;
};

export function createHistoryContext(
  snapshot: FrontendHistorySnapshot,
  entries: readonly HistoryRow[],
  live: () => void,
  actions: HistoryActions,
): HistoryContext {
  const rows = Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        id: entry.id,
        hostId: entry.hostId,
        command: entry.command.slice(0, 4000),
        executedAt: entry.executedAt,
        truncated: entry.command.length > 4000,
      }),
    ),
  );
  const available = new Map(rows.map((entry) => [entry.id, entry]));
  const data = Object.freeze({
    sessionId: snapshot.sessionId,
    hostId: snapshot.hostId,
    title: snapshot.title,
    revision: snapshot.revision,
    query: snapshot.query,
    total: rows.length,
    busy: snapshot.busy,
    error: snapshot.error,
  });
  const ready = (mutation = false) => {
    live();
    if (!actions.validate()) throw new Error("plugin.history.changed");
    if (mutation && (data.busy || data.error)) throw new Error("plugin.history.busy");
  };
  const entry = (id: number) => {
    ready(true);
    if (!Number.isSafeInteger(id) || !available.has(id)) throw new Error("plugin.history.invalid");
    return available.get(id)!;
  };
  return Object.freeze({
    snapshot: data,
    read: (request) => {
      if (!request || typeof request !== "object") throw new Error("plugin.history.invalid");
      if (request.revision !== data.revision) throw new Error("plugin.history.changed");
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
        throw new Error("plugin.history.invalid");
      const items: Readonly<FrontendHistoryEntry>[] = [];
      let next = offset,
        size = 0;
      for (; next < rows.length && items.length < 128; next++) {
        const row = rows[next]!;
        if (size + row.command.length > 65536) break;
        size += row.command.length;
        items.push(row);
      }
      return Object.freeze({
        revision: data.revision,
        total: rows.length,
        nextOffset: next < rows.length ? next : null,
        items: Object.freeze(items),
      });
    },
    setQuery: (query) => {
      ready();
      if (typeof query !== "string" || query.length > 4096)
        throw new Error("plugin.history.invalid");
      actions.setQuery(query);
    },
    refresh: () => {
      ready();
      actions.refresh();
    },
    delete: async (id) => actions.delete(entry(id)),
    requestClear: (authorize) => {
      ready(true);
      actions.requestClear(authorize);
    },
    execute: async (id) => {
      const row = entry(id);
      if (row.truncated) throw new Error("plugin.history.invalid");
      await actions.execute(row);
    },
  });
}
