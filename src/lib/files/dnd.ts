import type { FsSource } from "@/lib/api/types";

export const DRAG_MIME = "application/x-tunnelde-file";
let activeDragSource: FsSource | null = null;

/** The browser hides drag data during dragover; keep only the source in memory. */
export function currentDragSource(): FsSource | null {
  return activeDragSource;
}

export function clearDragSource(): void {
  activeDragSource = null;
}

export interface DragItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface DragPayload {
  source: FsSource;
  items: DragItem[];
  paneId?: string;
}

/** One source/destination pair inside a batch operation. */
export interface DropOp {
  from: string;
  to: string;
}

export type DropAction =
  | { kind: "noop" }
  | { kind: "move"; source: FsSource; ops: DropOp[] }
  | { kind: "copy"; source: FsSource; ops: DropOp[] }
  | {
      kind: "transfer";
      from: FsSource;
      to: FsSource;
      ops: DropOp[];
      move: boolean;
    };

export interface PasteClip {
  source: FsSource;
  action: "cut" | "copy";
  items: DragItem[];
}

export function sourceKey(source: FsSource): string {
  return source.kind === "local" ? "local" : `remote:${source.sessionId}`;
}

export function sameSource(left: FsSource, right: FsSource): boolean {
  return sourceKey(left) === sourceKey(right);
}

// Windows drive letters are sufficient to identify different volumes, but
// matching letters do not prove two paths are on the same mounted filesystem.
function differentWindowsDrives(source: FsSource, items: DragItem[], target: string): boolean {
  if (source.kind !== "local") return false;
  const destination = /^([a-z]):[\\/]/i.exec(target)?.[1]?.toLowerCase();
  return (
    !!destination &&
    items.some((item) => {
      const drive = /^([a-z]):[\\/]/i.exec(item.path)?.[1]?.toLowerCase();
      return !!drive && drive !== destination;
    })
  );
}

export function separatorFor(source: FsSource, path = ""): string {
  return source.kind === "remote" || path.startsWith("/") ? "/" : "\\";
}

export function joinPath(directory: string, name: string, separator: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) {
    return `${separator}${name}`;
  }
  return `${trimmed}${separator}${name}`;
}

export function parentOf(path: string): string {
  if (/^[/\\]+$/.test(path)) {
    return path.startsWith("/") ? "/" : "\\";
  }
  if (/^[A-Za-z]:[/\\]*$/.test(path)) {
    return `${path.slice(0, 2)}\\`;
  }
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(path)) {
    return path.replace(/\\+$/, "");
  }
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = index <= 0 ? trimmed.slice(0, index + 1) : trimmed.slice(0, index);
  // A drive root keeps its separator so joining a name still works.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent || "/";
}

/** A single file name, never an absolute path or a traversal. */
export function validName(name: string, source: FsSource, directory: string): boolean {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\]/.test(name) ||
    name.includes(String.fromCharCode(0))
  ) {
    return false;
  }
  return (
    source.kind !== "local" ||
    separatorFor(source, directory) !== "\\" ||
    (!/[<>:"|?*]/.test(name) &&
      !Array.from(name).some((char) => char.charCodeAt(0) < 32) &&
      !/[. ]$/.test(name) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
  );
}

export function isInside(parent: string, candidate: string): boolean {
  const base = parent.replace(/[\\/]+$/, "");
  if (!base) {
    return false;
  }
  return (
    candidate === base || candidate.startsWith(`${base}/`) || candidate.startsWith(`${base}\\`)
  );
}

function parsedSource(value: unknown): FsSource | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { kind?: unknown; sessionId?: unknown };
  if (candidate.kind === "local") {
    return { kind: "local" };
  }
  if (candidate.kind === "remote" && typeof candidate.sessionId === "string") {
    return { kind: "remote", sessionId: candidate.sessionId };
  }
  return null;
}

function parsedItems(value: unknown): DragItem[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const items: DragItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const candidate = entry as { path?: unknown; name?: unknown; isDir?: unknown };
    if (
      typeof candidate.path !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.isDir !== "boolean"
    ) {
      return null;
    }
    items.push({ path: candidate.path, name: candidate.name, isDir: candidate.isDir });
  }
  return items;
}

export function setDragPayload(data: DataTransfer, payload: DragPayload): void {
  activeDragSource = payload.source;
  data.setData(DRAG_MIME, JSON.stringify(payload));
  data.effectAllowed = "copyMove";
}

export function readDragPayload(data: DataTransfer): DragPayload | null {
  const raw = data.getData(DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { source?: unknown; items?: unknown; paneId?: unknown };
    const source = parsedSource(parsed.source);
    const items = parsedItems(parsed.items);
    return source && items
      ? {
          source,
          items,
          ...(typeof parsed.paneId === "string" ? { paneId: parsed.paneId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns a dragged selection into the operations a drop performs: a rename inside
 * one filesystem, a transfer between filesystems, or nothing when every item would land where
 * it already is.
 */
export function resolveDrop(
  payload: DragPayload,
  target: FsSource,
  targetDirectory: string,
  _targetPaneId?: string,
  sameFilesystem = sameSource,
): DropAction {
  const separator = separatorFor(target, targetDirectory);
  const ops: DropOp[] = [];

  for (const item of payload.items) {
    const destination = joinPath(targetDirectory, item.name, separator);
    if (sameFilesystem(payload.source, target)) {
      if (destination === item.path || isInside(item.path, targetDirectory)) {
        continue;
      }
    }
    ops.push({ from: item.path, to: destination });
  }

  if (ops.length === 0) {
    return { kind: "noop" };
  }
  if (
    target.kind === "local" &&
    differentWindowsDrives(payload.source, payload.items, targetDirectory)
  ) {
    return { kind: "transfer", from: payload.source, to: target, ops, move: false };
  }
  if (sameFilesystem(payload.source, target)) {
    return {
      kind: "move",
      source: target,
      ops,
    };
  }
  return { kind: "transfer", from: payload.source, to: target, ops, move: false };
}

/** Turns a cut or copied selection into the operations a paste performs. */
export function planPaste(
  clip: PasteClip,
  target: FsSource,
  targetDirectory: string,
  sameFilesystem = sameSource,
): DropAction {
  if (clip.items.length === 0) {
    return { kind: "noop" };
  }
  if (target.kind === "local" && differentWindowsDrives(clip.source, clip.items, targetDirectory)) {
    return pasteAcross(clip, target, targetDirectory);
  }
  return sameFilesystem(clip.source, target)
    ? pasteWithin(clip, target, targetDirectory)
    : pasteAcross(clip, target, targetDirectory);
}

function pasteWithin(clip: PasteClip, target: FsSource, directory: string): DropAction {
  const separator = separatorFor(target, directory);
  const ops: DropOp[] = [];
  for (const item of clip.items) {
    const destination = joinPath(directory, item.name, separator);
    if (destination === item.path || isInside(item.path, directory)) {
      continue;
    }
    ops.push({ from: item.path, to: destination });
  }
  if (ops.length === 0) {
    return { kind: "noop" };
  }
  return clip.action === "cut"
    ? { kind: "move", source: target, ops }
    : { kind: "copy", source: target, ops };
}

function pasteAcross(clip: PasteClip, target: FsSource, directory: string): DropAction {
  const separator = separatorFor(target, directory);
  const ops = clip.items.map((item) => ({
    from: item.path,
    to: joinPath(directory, item.name, separator),
  }));
  return {
    kind: "transfer",
    from: clip.source,
    to: target,
    ops,
    move: clip.action === "cut",
  };
}

export function canPaste(
  clip: PasteClip | null,
  target: FsSource,
  targetDirectory: string,
  sameFilesystem = sameSource,
): boolean {
  return clip !== null && planPaste(clip, target, targetDirectory, sameFilesystem).kind !== "noop";
}
