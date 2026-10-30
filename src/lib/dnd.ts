// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

export type FileSide = "local" | "remote";

export const DRAG_MIME = "application/x-tunnelde-file";

export interface DragPayload {
  side: FileSide;
  path: string;
  name: string;
  isDir: boolean;
}

export type DropAction =
  | { kind: "noop" }
  | { kind: "move"; from: string; to: string }
  | { kind: "transfer"; direction: "upload" | "download"; from: string; to: string };

export function setDragPayload(data: DataTransfer, payload: DragPayload): void {
  data.setData(DRAG_MIME, JSON.stringify(payload));
  data.effectAllowed = "copyMove";
}

export function readDragPayload(data: DataTransfer): DragPayload | null {
  const raw = data.getData(DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload>;
    if (
      (parsed.side === "local" || parsed.side === "remote") &&
      typeof parsed.path === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.isDir === "boolean"
    ) {
      return {
        side: parsed.side,
        path: parsed.path,
        name: parsed.name,
        isDir: parsed.isDir,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function separatorFor(side: FileSide): string {
  return side === "remote" ? "/" : "\\";
}

export function joinPath(directory: string, name: string, separator: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) {
    return `${separator}${name}`;
  }
  return `${trimmed}${separator}${name}`;
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index <= 0) {
    return trimmed.slice(0, index + 1);
  }
  return trimmed.slice(0, index);
}

/**
 * Decides what a drop means: a move inside one pane, an upload, a download or
 * nothing when the file is dropped into the folder it already lives in.
 */
export function resolveDrop(
  payload: DragPayload,
  targetSide: FileSide,
  targetDirectory: string,
): DropAction {
  if (payload.isDir && targetDirectory === payload.path) {
    return { kind: "noop" };
  }

  if (payload.side === targetSide) {
    const destination = joinPath(targetDirectory, payload.name, separatorFor(targetSide));
    if (destination === payload.path) {
      return { kind: "noop" };
    }
    return { kind: "move", from: payload.path, to: destination };
  }

  const destination = joinPath(targetDirectory, payload.name, separatorFor(targetSide));
  return {
    kind: "transfer",
    direction: payload.side === "local" ? "upload" : "download",
    from: payload.path,
    to: destination,
  };
}
