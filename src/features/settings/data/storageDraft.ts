import type { StorageCategory, StorageChange } from "@/lib/api/storage";
export type StorageDraftChange =
  | { kind: "merge"; remove: StorageCategory[]; changes: StorageChange[] }
  | { kind: "remove"; categories: StorageCategory[] }
  | { kind: "migrate"; category: StorageCategory; migrate: boolean }
  | { kind: "clear" };
/** Evaluate narrow draft edits at the owner; do not replace a stale whole store. */
export function changeStorageDraft(
  current: StorageChange[],
  change: StorageDraftChange,
): StorageChange[] {
  switch (change.kind) {
    case "merge":
      return [
        ...current.filter((item) => !change.remove.includes(item.category)),
        ...change.changes,
      ];
    case "remove":
      return current.filter((item) => !change.categories.includes(item.category));
    case "migrate":
      return current.map((item) =>
        item.category === change.category ? { ...item, migrate: change.migrate } : item,
      );
    case "clear":
      return [];
  }
}
