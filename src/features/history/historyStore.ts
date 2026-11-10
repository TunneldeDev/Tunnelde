import type { HistoryEntry } from "@/lib/api/types";
import { createInvalidatedListStore } from "@/lib/data/invalidatedListStore";

export function createHistoryStore(
  load: () => Promise<HistoryEntry[]>,
  report: (error: unknown) => void,
) {
  return createInvalidatedListStore(load, report);
}
