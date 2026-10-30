// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import {
  canPaste,
  DRAG_MIME,
  isInside,
  joinPath,
  parentOf,
  planPaste,
  readDragPayload,
  resolveDrop,
  sameSource,
  setDragPayload,
  type PasteClip,
} from "@/lib/files/dnd";
import type { FsSource } from "@/lib/api/types";

const LOCAL: FsSource = { kind: "local" };
const SERVER_A: FsSource = { kind: "remote", sessionId: "a" };
const SERVER_B: FsSource = { kind: "remote", sessionId: "b" };

function fakeTransfer(seed: Record<string, string> = {}): DataTransfer {
  const store: Record<string, string> = { ...seed };
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

describe("path helpers", () => {
  it("joins with the separator of the target side", () => {
    expect(joinPath("/home/user", "a.txt", "/")).toBe("/home/user/a.txt");
    expect(joinPath("/home/user/", "a.txt", "/")).toBe("/home/user/a.txt");
    expect(joinPath("", "a.txt", "/")).toBe("/a.txt");
    expect(joinPath("C:\\work", "a.txt", "\\")).toBe("C:\\work\\a.txt");
  });

  it("walks up one level", () => {
    expect(parentOf("/home/user/a.txt")).toBe("/home/user");
    expect(parentOf("/home/user/")).toBe("/home");
  });

  it("detects containment", () => {
    expect(isInside("/home/user", "/home/user/docs")).toBe(true);
    expect(isInside("/home/user", "/home/user")).toBe(true);
    expect(isInside("/home/user", "/home/username")).toBe(false);
  });
});

describe("drag payloads", () => {
  it("round-trips a source", () => {
    const store = fakeTransfer();
    setDragPayload(store, {
      source: SERVER_B,
      path: "/srv/app",
      name: "app",
      isDir: true,
    });
    expect(readDragPayload(store)).toEqual({
      source: SERVER_B,
      path: "/srv/app",
      name: "app",
      isDir: true,
    });
  });

  it("rejects unknown shapes", () => {
    expect(readDragPayload(fakeTransfer())).toBeNull();
    expect(readDragPayload(fakeTransfer({ [DRAG_MIME]: "{" }))).toBeNull();
    const payload = JSON.stringify({
      source: { kind: "network" },
      path: "/a",
      name: "a",
      isDir: false,
    });
    expect(readDragPayload(fakeTransfer({ [DRAG_MIME]: payload }))).toBeNull();
  });
});

describe("resolveDrop", () => {
  const file = { path: "/home/user/a.txt", name: "a.txt", isDir: false };

  it("renames inside one panel", () => {
    expect(resolveDrop({ source: SERVER_A, ...file }, SERVER_A, "/srv/backup")).toEqual({
      kind: "move",
      source: SERVER_A,
      from: "/home/user/a.txt",
      to: "/srv/backup/a.txt",
    });
  });

  it("ignores a drop into the folder it already lives in", () => {
    expect(resolveDrop({ source: SERVER_A, ...file }, SERVER_A, "/home/user")).toEqual({
      kind: "noop",
    });
  });

  it("refuses to move a folder into itself", () => {
    expect(
      resolveDrop(
        { source: SERVER_A, path: "/srv/app", name: "app", isDir: true },
        SERVER_A,
        "/srv/app/nested",
      ),
    ).toEqual({ kind: "noop" });
  });

  it("copies between two panels", () => {
    expect(resolveDrop({ source: LOCAL, ...file }, SERVER_A, "/srv")).toEqual({
      kind: "transfer",
      from: LOCAL,
      to: SERVER_A,
      fromPath: "/home/user/a.txt",
      toPath: "/srv/a.txt",
      move: false,
    });
  });

  it("transfers folders across panels", () => {
    const folder = { path: "/srv/app", name: "app", isDir: true };
    expect(resolveDrop({ source: SERVER_A, ...folder }, SERVER_B, "/opt")).toEqual({
      kind: "transfer",
      from: SERVER_A,
      to: SERVER_B,
      fromPath: "/srv/app",
      toPath: "/opt/app",
      move: false,
    });
  });
});

describe("planPaste", () => {
  const clip: PasteClip = {
    source: SERVER_A,
    action: "cut",
    path: "/srv/app",
    name: "app",
    isDir: true,
  };

  it("moves a cut entry inside one panel", () => {
    expect(planPaste(clip, SERVER_A, "/opt")).toEqual({
      kind: "move",
      source: SERVER_A,
      from: "/srv/app",
      to: "/opt/app",
    });
  });

  it("copies a copied entry inside one panel", () => {
    expect(planPaste({ ...clip, action: "copy" }, SERVER_A, "/opt")).toEqual({
      kind: "copy",
      source: SERVER_A,
      from: "/srv/app",
      to: "/opt/app",
    });
  });

  it("keeps the cut flag across panels", () => {
    expect(planPaste(clip, LOCAL, "C:\\work")).toMatchObject({
      kind: "transfer",
      from: SERVER_A,
      to: LOCAL,
      move: true,
    });
  });

  it("pastes nothing into the current folder", () => {
    expect(canPaste(clip, SERVER_A, "/srv")).toBe(false);
    expect(canPaste(null, SERVER_A, "/opt")).toBe(false);
    expect(canPaste(clip, SERVER_A, "/opt")).toBe(true);
  });
});

describe("sourceKey", () => {
  it("compares sources", () => {
    expect(sameSource(LOCAL, { kind: "local" })).toBe(true);
    expect(sameSource(SERVER_A, SERVER_B)).toBe(false);
  });
});
