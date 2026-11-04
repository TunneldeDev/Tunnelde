export const STORAGE_CATEGORIES = [
  "database",
  "plugins",
  "pluginData",
  "keys",
  "runtimes",
  "cache",
  "logs",
  "runners",
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];
export interface StorageChange {
  category: StorageCategory;
  target: string;
  migrate: boolean;
}
export interface StorageLocation {
  category: StorageCategory;
  path: string;
  defaultPath: string;
  bytes: number;
  files: number;
  error: string | null;
  overridden: boolean;
}
export interface StorageStatus {
  locations: StorageLocation[];
  pending: { id: string; changes: StorageChange[] } | null;
  previous: Partial<Record<StorageCategory, string>>;
  archives?: Partial<Record<StorageCategory, string>>;
  lastError: string | null;
}

export function storageChild(parent: string, category: StorageCategory): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  const folder = category === "pluginData" ? "plugin-data" : category;
  return `${parent.replace(/[\\/]+$/, "")}${separator}${folder}`;
}

export function displayStoragePath(path: string): string {
  return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.replace(/^\\\\\?\\/, "");
}

/** Compare displayed paths without changing case-sensitive Unix paths. */
export function sameStoragePath(left: string, right: string): boolean {
  const normalize = (path: string) => {
    if (!path) return "";
    const displayed = displayStoragePath(path);
    const windows = /^[a-z]:[\\/]/i.test(displayed) || displayed.startsWith("\\\\");
    const normalized =
      (windows ? displayed.replace(/\\/g, "/") : displayed).replace(/\/+$/, "") || "/";
    return windows ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}
