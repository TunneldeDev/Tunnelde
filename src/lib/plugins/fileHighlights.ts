/** Plugin file-list highlights are semantic and host-rendered, never raw CSS. */
export type FileHighlightTone = "neutral" | "info" | "success" | "warning" | "error";

export interface FileHighlight {
  match: {
    name?: string | null;
    extension?: string | null;
    pathPrefix?: string | null;
  };
  tooltip: string | null;
  tone: FileHighlightTone;
}

export interface FileHighlightSet {
  id: string;
  priority: number;
  source: string;
  directory?: string | null;
  highlights: FileHighlight[];
  pluginId: string;
  pluginName: string;
}

export interface FileHighlightSnapshot {
  revision: number;
  items: FileHighlightSet[];
}

export interface OwnedFileHighlight extends FileHighlight {
  key: string;
  pluginId: string;
  pluginName: string;
  source: string;
  directory: string | null;
}

export function fileHighlightSource(
  source: { kind: "local" } | { kind: "remote"; sessionId: string },
) {
  return source.kind === "local" ? "local" : source.sessionId;
}

/** Index once per native snapshot. Higher priority wins; ties are deterministic. */
export function indexFileHighlights(
  items: FileHighlightSet[],
): ReadonlyMap<string, OwnedFileHighlight[]> {
  const index = new Map<string, OwnedFileHighlight[]>();
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...items].sort(
    (a, b) => b.priority - a.priority || compare(a.pluginId, b.pluginId) || compare(a.id, b.id),
  );
  for (const set of sorted) {
    const source = set.source.replace(/^remote:/, "");
    for (const [position, item] of set.highlights.entries()) {
      const key = JSON.stringify([set.pluginId, set.id, position]);
      const values = index.get(source) ?? [];
      values.push(
        Object.freeze({
          match: Object.freeze({ ...item.match }),
          tooltip: item.tooltip,
          tone: item.tone,
          key,
          pluginId: set.pluginId,
          pluginName: set.pluginName,
          source,
          directory: set.directory ?? null,
        }),
      );
      index.set(source, values);
    }
  }
  return index;
}

function scopedFileHighlights(
  index: ReadonlyMap<string, OwnedFileHighlight[]>,
  source: string,
  directory: string | null,
): OwnedFileHighlight[] {
  const scoped = (item: OwnedFileHighlight) =>
    item.directory === null || item.directory === directory;
  return [...(index.get(source) ?? []), ...(index.get("") ?? [])].filter(scoped);
}

/** All matching plugin labels for the row title; the visual winner remains first. */
export function matchingFileHighlightLabels(
  index: ReadonlyMap<string, OwnedFileHighlight[]>,
  source: string,
  path: string,
  name: string,
  isDir: boolean,
  directory: string | null,
): string[] {
  return scopedFileHighlights(index, source, directory)
    .filter((item) => matches(item, path, name, isDir))
    .map(fileHighlightLabel);
}

function matches(item: OwnedFileHighlight, path: string, name: string, isDir: boolean) {
  const match = item.match;
  if (match.name != null) return name === match.name;
  if (match.extension != null) {
    if (isDir) return false;
    const dot = name.lastIndexOf("."),
      extension = match.extension;
    return dot > 0 && name.slice(dot + 1).toLowerCase() === extension.toLowerCase();
  }
  return match.pathPrefix != null && path.startsWith(match.pathPrefix);
}

/** Source-specific rules win first; within a source, the first matching rule wins. */
export function resolveFileHighlight(
  index: ReadonlyMap<string, OwnedFileHighlight[]>,
  source: string,
  path: string,
  name: string,
  isDir: boolean,
  directory: string | null = null,
): OwnedFileHighlight | null {
  const inDirectory = (item: OwnedFileHighlight) =>
    item.directory === null || item.directory === directory;
  for (const item of index.get(source) ?? [])
    if (inDirectory(item) && matches(item, path, name, isDir)) return item;
  for (const item of index.get("") ?? [])
    if (inDirectory(item) && matches(item, path, name, isDir)) return item;
  return null;
}

export function fileHighlightLabel(item: OwnedFileHighlight): string {
  return [item.pluginName, item.tooltip].filter(Boolean).join(" · ");
}
