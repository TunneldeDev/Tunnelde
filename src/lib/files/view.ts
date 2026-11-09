import type { FileEntry } from "@/lib/api/types";
import {
  matchesSearch,
  matchesSearchNumber,
  matchesSearchDate,
  parseSearchQuery,
} from "@/lib/search/query";

export const FILE_COLUMNS = ["name", "type", "size", "modified"] as const;
export type FileColumn = (typeof FILE_COLUMNS)[number];
export const DEFAULT_COLUMN_WIDTHS: Record<FileColumn, number> = {
  name: 220,
  type: 90,
  size: 90,
  modified: 150,
};
export function normalizeFileColumns(value: unknown): FileColumn[] {
  const valid = Array.isArray(value)
    ? value.filter((v): v is FileColumn => FILE_COLUMNS.includes(v as FileColumn))
    : [];
  const unique = [...new Set(valid)];
  return unique.includes("name") ? unique : ["name", ...unique];
}

export interface FileViewPreferences {
  filesColumns?: FileColumn[];
  filesColumnWidths?: Partial<Record<FileColumn, number>>;
  filesLayout?: "details" | "columns";
  filesShowHidden: boolean;
  filesFoldersFirst: boolean;
  filesSortBy: "name" | "size" | "modified" | "type";
  filesSortDirection: "asc" | "desc";
  filesGroupBy?: "none" | "type" | "modified" | "initial";
}

export type FileKindFilter = "all" | "files" | "folders";
export interface FileFilter {
  query: string;
  kind: FileKindFilter;
}
const NO_FILTER: FileFilter = { query: "", kind: "all" };
export function fileExtension(entry: FileEntry): string {
  if (entry.isDir) return "";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 && dot < entry.name.length - 1
    ? entry.name
        .slice(dot + 1)
        .normalize("NFKC")
        .toLowerCase()
    : "";
}

const NONE: readonly string[] = [];

export function visibleFiles(
  entries: readonly FileEntry[],
  preferences: FileViewPreferences,
  collator: Intl.Collator,
  revealed: readonly string[] = NONE,
  filter: FileFilter = NO_FILTER,
): FileEntry[] {
  const forced = new Set(revealed);
  const direction = preferences.filesSortDirection === "desc" ? -1 : 1;
  const byName = (left: FileEntry, right: FileEntry) =>
    collator.compare(left.name, right.name) ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const locale = collator.resolvedOptions().locale;
  const query = parseSearchQuery(filter.query, [
    "name",
    "ext",
    "type",
    "is",
    "path",
    "size",
    "modified",
  ]);
  const hiddenRequested = query.filters.some(
    (term) => !term.exclude && term.key === "is" && term.values.includes("hidden"),
  );
  return entries
    .filter(
      (entry) =>
        forced.has(entry.path) ||
        ((preferences.filesShowHidden ||
          hiddenRequested ||
          !(entry.isHidden || entry.name.startsWith("."))) &&
          (filter.kind === "all" || entry.isDir === (filter.kind === "folders")) &&
          matchesSearch(query, entry.name, {
            name: (value) => entry.name.normalize("NFKC").toLocaleLowerCase(locale).includes(value),
            ext: fileExtension(entry),
            type: entry.isDir ? ["folder", "directory"] : ["file"],
            is: entry.isHidden || entry.name.startsWith(".") ? ["hidden"] : [],
            path: (value) => entry.path.normalize("NFKC").toLocaleLowerCase(locale).includes(value),
            size: (value) => !entry.isDir && matchesSearchNumber(entry.size, value),
            modified: (value) => matchesSearchDate(entry.modified, value),
          })),
    )
    .sort((left, right) => {
      if (preferences.filesFoldersFirst && left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      if (preferences.filesSortBy === "name") return direction * byName(left, right);
      if (preferences.filesSortBy === "type") {
        if (left.isDir !== right.isDir) return direction * (left.isDir ? -1 : 1);
        return (
          direction * collator.compare(fileExtension(left), fileExtension(right)) ||
          byName(left, right)
        );
      }
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
    filter: FileFilter = NO_FILTER,
  ): FileEntry[] => {
    const key = JSON.stringify([
      preferences.filesShowHidden,
      preferences.filesFoldersFirst,
      preferences.filesSortBy,
      preferences.filesSortDirection,
      filter.query,
      filter.kind,
    ]);
    if (
      previous?.entries === entries &&
      previous.preferences === key &&
      previous.collator === collator &&
      previous.revealed === revealed
    )
      return previous.result;
    const result = visibleFiles(entries, preferences, collator, revealed, filter);
    previous = { entries, preferences: key, collator, revealed, result };
    return result;
  };
}

export interface FileGroup {
  key: string;
  entries: FileEntry[];
  collapsed: boolean;
}
export interface FileView {
  groups: FileGroup[];
  entries: FileEntry[];
  total: number;
}
export function fileGroupKey(entry: FileEntry, mode: FileViewPreferences["filesGroupBy"]): string {
  if (mode === "type")
    return entry.isDir
      ? "folders"
      : fileExtension(entry)
        ? `extension:${fileExtension(entry)}`
        : "files";
  if (mode === "modified") {
    if (entry.modified === null || !Number.isFinite(entry.modified)) return "unknown";
    const date = new Date(entry.modified);
    if (Number.isNaN(date.getTime())) return "unknown";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  if (mode === "initial") {
    const first = Array.from(entry.name.normalize("NFKC"))[0] ?? "#";
    return /\p{N}/u.test(first) ? "0–9" : /\p{L}/u.test(first) ? first.toLocaleUpperCase() : "#";
  }
  return "";
}

/** Sorting/filtering is cached independently from selection and group folding. */
export function createGroupedFileViewSelector() {
  const select = createFileViewSelector();
  let previous:
    | {
        sorted: FileEntry[];
        mode: FileViewPreferences["filesGroupBy"];
        collator: Intl.Collator;
        groups: Map<string, FileEntry[]>;
      }
    | undefined;
  let last:
    | {
        groups: Map<string, FileEntry[]>;
        collapsed: readonly string[];
        revealed: readonly string[];
        result: FileView;
      }
    | undefined;
  return (
    entries: readonly FileEntry[],
    preferences: FileViewPreferences,
    collator: Intl.Collator,
    revealed: readonly string[] = NONE,
    filter: FileFilter = NO_FILTER,
    collapsed: readonly string[] = NONE,
  ): FileView => {
    const sorted = select(entries, preferences, collator, revealed, filter);
    const mode = preferences.filesGroupBy ?? "none";
    if (previous?.sorted !== sorted || previous.mode !== mode || previous.collator !== collator) {
      const buckets = new Map<string, FileEntry[]>();
      for (const entry of sorted) {
        const key = fileGroupKey(entry, mode);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(entry);
        else buckets.set(key, [entry]);
      }
      const keys = [...buckets.keys()].sort((a, b) => {
        if (mode === "modified")
          return a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a);
        if (mode === "type")
          return a === "folders" ? -1 : b === "folders" ? 1 : collator.compare(a, b);
        return collator.compare(a, b);
      });
      previous = {
        sorted,
        mode,
        collator,
        groups: new Map(keys.map((key) => [key, buckets.get(key)!])),
      };
    }
    if (
      last?.groups === previous.groups &&
      last.collapsed === collapsed &&
      last.revealed === revealed
    )
      return last.result;
    const folded = new Set(collapsed),
      forced = new Set(revealed);
    const groups = [...previous.groups].map(([key, items]) => ({
      key,
      entries: items,
      collapsed: mode !== "none" && folded.has(key) && !items.some((item) => forced.has(item.path)),
    }));
    const result = {
      groups,
      entries: groups.flatMap((group) => (group.collapsed ? [] : group.entries)),
      total: sorted.length,
    };
    last = { groups: previous.groups, collapsed, revealed, result };
    return result;
  };
}
