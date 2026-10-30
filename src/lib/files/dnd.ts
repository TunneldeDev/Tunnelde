// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { FsSource } from "@/lib/api/types";

export const DRAG_MIME = "application/x-tunnelde-file";

export interface DragPayload {
  source: FsSource;
  path: string;
  name: string;
  isDir: boolean;
}

export type DropAction =
  | { kind: "noop" }
  | { kind: "move"; source: FsSource; from: string; to: string }
  | { kind: "copy"; source: FsSource; from: string; to: string }
  | {
      kind: "transfer";
      from: FsSource;
      to: FsSource;
      fromPath: string;
      toPath: string;
      move: boolean;
    };

export interface PasteClip {
  source: FsSource;
  action: "cut" | "copy";
  path: string;
  name: string;
  isDir: boolean;
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
  if (index <= 0) {
    return trimmed.slice(0, index + 1);
  }
  return trimmed.slice(0, index);
}

export function isInside(parent: string, candidate: string): boolean {
  const base = parent.replace(/[\\/]+$/, "");
  if (!base) {
    return false;
  }
  return candidate === base || candidate.startsWith(`${base}/`) || candidate.startsWith(`${base}\\`);
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
    const parsed = JSON.parse(raw) as {
      source?: unknown;
      path?: unknown;
      name?: unknown;
      isDir?: unknown;
    };
    const source = parsedSource(parsed.source);
    if (
      source &&
      typeof parsed.path === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.isDir === "boolean"
    ) {
      return { source, path: parsed.path, name: parsed.name, isDir: parsed.isDir };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Decides what a drop means: a rename inside one panel, a copy between two
 * panels, or nothing when the target is where the entry already lives.
 */
export function resolveDrop(
  payload: DragPayload,
  target: FsSource,
  targetDirectory: string,
): DropAction {
  const destination = joinPath(targetDirectory, payload.name, separatorFor(target));

  if (sameSource(payload.source, target)) {
    if (destination === payload.path || isInside(payload.path, targetDirectory)) {
      return { kind: "noop" };
    }
    return { kind: "move", source: target, from: payload.path, to: destination };
  }

  return {
    kind: "transfer",
    from: payload.source,
    to: target,
    fromPath: payload.path,
    toPath: destination,
    move: false,
  };
}

/** Turns a cut or copied entry into the operation a paste performs. */
export function planPaste(
  clip: PasteClip,
  target: FsSource,
  targetDirectory: string,
): DropAction {
  const destination = joinPath(targetDirectory, clip.name, separatorFor(target));

  if (sameSource(clip.source, target)) {
    if (destination === clip.path || isInside(clip.path, targetDirectory)) {
      return { kind: "noop" };
    }
    return clip.action === "cut"
      ? { kind: "move", source: target, from: clip.path, to: destination }
      : { kind: "copy", source: target, from: clip.path, to: destination };
  }

  return {
    kind: "transfer",
    from: clip.source,
    to: target,
    fromPath: clip.path,
    toPath: destination,
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
