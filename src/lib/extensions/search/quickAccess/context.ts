import type { QuickAccessController } from "@/features/quickAccess/runtime/useController";
import type { FrontendQuickAccess } from "../../contracts/search/quickAccess/provider";
import { projectQuickAccess } from "./projection";

export type QuickAccessContext = Omit<FrontendQuickAccess, "Entries" | "capabilities">;
export function createQuickAccessContext(manager: QuickAccessController): QuickAccessContext {
  const rows = projectQuickAccess(manager.filtered);
  const revision = manager.frame.revision;
  const snapshot = Object.freeze({
    revision,
    mode: manager.mode,
    query: manager.query.slice(0, 4096),
    root: manager.root
      ? Object.freeze({ path: manager.root.path.slice(0, 4096), sessionId: manager.root.sessionId })
      : null,
    selectedKey: rows[manager.index]?.key ?? null,
    total: rows.length,
    busy: manager.searching,
    error: manager.error ? manager.error.slice(0, 1024) : null,
    limited: manager.limited,
    skipped: manager.result?.key === manager.searchKey ? manager.result.skipped : 0,
  });
  const ready = () => {
    if (!manager.validate()) throw new Error("plugin.quickAccess.changed");
  };
  const entry = (request: { revision: string; key: string }) => {
    ready();
    if (!request || typeof request !== "object" || request.revision !== revision)
      throw new Error("plugin.quickAccess.changed");
    const index = rows.findIndex((row) => row.key === request.key);
    if (index < 0) throw new Error("plugin.quickAccess.invalid");
    return index;
  };
  return Object.freeze<QuickAccessContext>({
    snapshot,
    read(request) {
      if (!request || typeof request !== "object" || request.revision !== revision)
        throw new Error("plugin.quickAccess.changed");
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
        throw new Error("plugin.quickAccess.invalid");
      const items = [];
      let next = offset,
        size = 2;
      for (; next < rows.length && items.length < 128; next++) {
        const row = rows[next]!,
          length = JSON.stringify(row).length + (items.length ? 1 : 0);
        if (size + length > 65536) break;
        items.push(row);
        size += length;
      }
      return Object.freeze({
        revision,
        total: rows.length,
        nextOffset: next < rows.length ? next : null,
        items: Object.freeze(items),
      });
    },
    setQuery(query) {
      ready();
      if (typeof query !== "string" || query.length > 4096)
        throw new Error("plugin.quickAccess.invalid");
      manager.setQuery(query);
    },
    select(request) {
      manager.setIndex(entry(request));
    },
    invoke(request) {
      manager.run(manager.filtered[entry(request)]);
    },
    close() {
      ready();
      manager.close();
    },
  });
}
