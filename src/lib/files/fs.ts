// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { api } from "@/lib/api/ipc";
import type { FsSource, Listing, TextFile } from "@/lib/api/types";

export const LOCAL_SOURCE: FsSource = { kind: "local" };

export function sourceKey(source: FsSource): string {
  return source.kind === "local" ? "local" : `remote:${source.sessionId}`;
}

export function sameSource(left: FsSource, right: FsSource): boolean {
  return sourceKey(left) === sourceKey(right);
}

/**
 * Every file operation goes through here so a panel never has to know whether
 * it is looking at this computer or at a server.
 */
export const fs = {
  list(source: FsSource, path?: string | null): Promise<Listing> {
    return source.kind === "local"
      ? api.localList(path ?? null)
      : api.sftpList(source.sessionId, path ?? null);
  },

  home(source: FsSource): Promise<string> {
    return source.kind === "local" ? api.localHome() : Promise.resolve(".");
  },

  mkdir(source: FsSource, path: string): Promise<void> {
    return source.kind === "local" ? api.localMkdir(path) : api.sftpMkdir(source.sessionId, path);
  },

  createFile(source: FsSource, path: string): Promise<void> {
    return source.kind === "local"
      ? api.localCreateFile(path)
      : api.sftpCreateFile(source.sessionId, path);
  },

  rename(source: FsSource, from: string, to: string, overwrite = false): Promise<void> {
    return source.kind === "local"
      ? api.localRename(from, to, overwrite)
      : api.sftpRename(source.sessionId, from, to, overwrite);
  },

  remove(source: FsSource, path: string, isDir: boolean): Promise<void> {
    return source.kind === "local"
      ? api.localDelete(path, isDir)
      : api.sftpDelete(source.sessionId, path, isDir);
  },

  copy(source: FsSource, from: string, to: string, overwrite = false): Promise<void> {
    return source.kind === "local"
      ? api.localCopy(from, to, overwrite)
      : api.sftpCopy(source.sessionId, from, to, overwrite);
  },

  transfer(
    from: FsSource,
    fromPath: string,
    to: FsSource,
    toPath: string,
    removeSource: boolean,
    overwrite = false,
  ): Promise<string> {
    const fromSession = from.kind === "local" ? null : from.sessionId;
    const toSession = to.kind === "local" ? null : to.sessionId;
    return api.fsTransfer(fromSession, fromPath, toSession, toPath, removeSource, overwrite);
  },

  readText(source: FsSource, path: string): Promise<TextFile | null> {
    return source.kind === "local"
      ? Promise.resolve(null)
      : api.sftpReadText(source.sessionId, path);
  },

  writeText(source: FsSource, path: string, content: string): Promise<void> {
    return source.kind === "local"
      ? Promise.reject(new Error("fs.localReadOnly"))
      : api.sftpWriteText(source.sessionId, path, content);
  },

  /** Hands a local file or folder to the system default application. */
  openLocal(path: string): Promise<void> {
    return api.openLocalPath(path);
  },
};

/** Remote files can be edited in place; local ones are opened by the OS. */
export function canEdit(source: FsSource): boolean {
  return source.kind === "remote";
}
