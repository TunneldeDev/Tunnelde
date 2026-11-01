import type { FileEntry } from "@/lib/api/types";

export interface FileViewPreferences {
  filesShowHidden: boolean;
  filesFoldersFirst: boolean;
  filesSortBy: "name" | "size" | "modified";
  filesSortDirection: "asc" | "desc";
}

const NONE: readonly string[] = [];

export function visibleFiles(
  entries: readonly FileEntry[],
  preferences: FileViewPreferences,
  collator: Intl.Collator,
  revealed: readonly string[] = NONE,
): FileEntry[] {
  const forced = new Set(revealed);
  const direction = preferences.filesSortDirection === "desc" ? -1 : 1;
  const byName = (left: FileEntry, right: FileEntry) =>
    collator.compare(left.name, right.name) ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return entries
    .filter(
      (entry) =>
        preferences.filesShowHidden ||
        !(entry.isHidden || entry.name.startsWith(".")) ||
        forced.has(entry.path),
    )
    .sort((left, right) => {
      if (preferences.filesFoldersFirst && left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      if (preferences.filesSortBy === "name") return direction * byName(left, right);
      if (preferences.filesSortBy === "modified") {
        // Unknown timestamps stay last in either direction.
        if (left.modified === null && right.modified !== null) return 1;
        if (left.modified !== null && right.modified === null) return -1;
      }
      const leftValue = preferences.filesSortBy === "size" ? left.size : (left.modified ?? 0);
      const rightValue = preferences.filesSortBy === "size" ? right.size : (right.modified ?? 0);
      return direction * (leftValue - rightValue) || byName(left, right);
    });
}

/** One selector per panel keeps every interaction on the same visible order. */
export function createFileViewSelector() {
  let previous:
    | {
        entries: readonly FileEntry[];
        preferences: string;
        collator: Intl.Collator;
        revealed: readonly string[];
        result: FileEntry[];
      }
    | undefined;
  return (
    entries: readonly FileEntry[],
    preferences: FileViewPreferences,
    collator: Intl.Collator,
    revealed: readonly string[] = NONE,
  ): FileEntry[] => {
    const key = `${preferences.filesShowHidden}|${preferences.filesFoldersFirst}|${preferences.filesSortBy}|${preferences.filesSortDirection}`;
    if (
      previous?.entries === entries &&
      previous.preferences === key &&
      previous.collator === collator &&
      previous.revealed === revealed
    )
      return previous.result;
    const result = visibleFiles(entries, preferences, collator, revealed);
    previous = { entries, preferences: key, collator, revealed, result };
    return result;
  };
}
