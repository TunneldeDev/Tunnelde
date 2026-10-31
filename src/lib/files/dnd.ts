// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { FsSource } from "@/lib/api/types";

export const DRAG_MIME = "application/x-tunnelde-file";

export interface DragItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface DragPayload {
  source: FsSource;
  items: DragItem[];
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

export function separatorFor(source: FsSource): string {
  return source.kind === "remote" ? "/" : "\\";
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
  const parent = index <= 0 ? trimmed.slice(0, index + 1) : trimmed.slice(0, index);
  // A drive root keeps its separator so joining a name still works.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
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
  data.setData(DRAG_MIME, JSON.stringify(payload));
  data.effectAllowed = "copyMove";
}

export function readDragPayload(data: DataTransfer): DragPayload | null {
  const raw = data.getData(DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { source?: unknown; items?: unknown };
    const source = parsedSource(parsed.source);
    const items = parsedItems(parsed.items);
    return source && items ? { source, items } : null;
  } catch {
    return null;
  }
}

/**
 * Turns a dragged selection into the operations a drop performs: a rename inside
 * one panel, a copy between panels, or nothing when every item would land where
 * it already is.
 */
export function resolveDrop(
  payload: DragPayload,
  target: FsSource,
  targetDirectory: string,
): DropAction {
  const separator = separatorFor(target);
  const ops: DropOp[] = [];

  for (const item of payload.items) {
    const destination = joinPath(targetDirectory, item.name, separator);
    if (sameSource(payload.source, target)) {
      if (destination === item.path || isInside(item.path, targetDirectory)) {
        continue;
      }
    }
    ops.push({ from: item.path, to: destination });
  }

  if (ops.length === 0) {
    return { kind: "noop" };
  }
  if (sameSource(payload.source, target)) {
    return { kind: "move", source: target, ops };
  }
  return { kind: "transfer", from: payload.source, to: target, ops, move: false };
}

/** Turns a cut or copied selection into the operations a paste performs. */
export function planPaste(
  clip: PasteClip,
  target: FsSource,
  targetDirectory: string,
): DropAction {
  if (clip.items.length === 0) {
    return { kind: "noop" };
  }
  return sameSource(clip.source, target)
    ? pasteWithin(clip, target, targetDirectory)
    : pasteAcross(clip, target, targetDirectory);
}

function pasteWithin(clip: PasteClip, target: FsSource, directory: string): DropAction {
  const separator = separatorFor(target);
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
  const separator = separatorFor(target);
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
): boolean {
  return clip !== null && planPaste(clip, target, targetDirectory).kind !== "noop";
}
