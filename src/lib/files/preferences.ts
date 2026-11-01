import type { FileViewPreferences } from "./view";

const PREFIX = "tunnelde:file-view:v1:";
const MAX_ENTRIES = 128;
export const fileViewPreferenceKey = (
  windowLabel: string,
  owner: string,
  pane: string,
  source: string,
) => PREFIX + JSON.stringify([windowLabel, owner, pane, source]);

export function readFileViewPreferences(
  key: string,
  defaults: FileViewPreferences,
): FileViewPreferences {
  const fallback = { ...defaults, filesGroupBy: defaults.filesGroupBy ?? "none" };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!parsed || typeof parsed !== "object" || !("view" in parsed)) return fallback;
    const view = (parsed as { view: Record<string, unknown> }).view;
    if (!view || typeof view !== "object") return fallback;
    return {
      filesShowHidden:
        typeof view.filesShowHidden === "boolean" ? view.filesShowHidden : fallback.filesShowHidden,
      filesFoldersFirst:
        typeof view.filesFoldersFirst === "boolean"
          ? view.filesFoldersFirst
          : fallback.filesFoldersFirst,
      filesSortBy: ["name", "size", "modified", "type"].includes(String(view.filesSortBy))
        ? (view.filesSortBy as FileViewPreferences["filesSortBy"])
        : fallback.filesSortBy,
      filesSortDirection:
        view.filesSortDirection === "asc" || view.filesSortDirection === "desc"
          ? view.filesSortDirection
          : fallback.filesSortDirection,
      filesGroupBy: ["none", "type", "modified", "initial"].includes(String(view.filesGroupBy))
        ? (view.filesGroupBy as FileViewPreferences["filesGroupBy"])
        : fallback.filesGroupBy,
    };
  } catch {
    return fallback;
  }
}

export function writeFileViewPreferences(key: string, view: FileViewPreferences): void {
  try {
    localStorage.setItem(key, JSON.stringify({ view, updatedAt: Date.now() }));
    const keys = Object.keys(localStorage).filter((item) => item.startsWith(PREFIX));
    if (keys.length <= MAX_ENTRIES) return;
    const oldest = keys
      .filter((item) => item !== key)
      .sort((a, b) => {
        const timestamp = (item: string): number => {
          try {
            return Number(JSON.parse(localStorage.getItem(item) ?? "{}").updatedAt) || 0;
          } catch {
            return 0;
          }
        };
        return timestamp(a) - timestamp(b);
      });
    for (const item of oldest.slice(0, keys.length - MAX_ENTRIES)) localStorage.removeItem(item);
  } catch {
    /* Preferences are optional when browser storage is unavailable. */
  }
}
