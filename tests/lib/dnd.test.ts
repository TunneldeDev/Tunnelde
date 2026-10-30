// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import {
  canPaste,
  joinPath,
  parentOf,
  planPaste,
  resolveDrop,
  type DragPayload,
  type PasteClip,
} from "@/lib/dnd";

const payload = (overrides: Partial<DragPayload> = {}): DragPayload => ({
  side: "remote",
  path: "/home/user/a.txt",
  name: "a.txt",
  isDir: false,
  ...overrides,
});

describe("dnd helpers", () => {
  it("joins and splits paths on both sides", () => {
    expect(joinPath("/home/user", "a.txt", "/")).toBe("/home/user/a.txt");
    expect(joinPath("C:\\work\\", "a.txt", "\\")).toBe("C:\\work\\a.txt");
    expect(parentOf("/home/user/a.txt")).toBe("/home/user");
    expect(parentOf("C:\\work\\a.txt")).toBe("C:\\work");
  });

  it("ignores drops into the same folder", () => {
    expect(resolveDrop(payload(), "remote", "/home/user")).toEqual({ kind: "noop" });
  });

  it("moves inside the same pane", () => {
    expect(resolveDrop(payload(), "remote", "/home/user/docs")).toEqual({
      kind: "move",
      from: "/home/user/a.txt",
      to: "/home/user/docs/a.txt",
    });
  });

  it("uploads from local to remote", () => {
    const local = payload({ side: "local", path: "C:\\tmp\\a.txt", name: "a.txt" });
    expect(resolveDrop(local, "remote", "/home/user")).toEqual({
      kind: "transfer",
      direction: "upload",
      from: "C:\\tmp\\a.txt",
      to: "/home/user/a.txt",
    });
  });

  it("downloads from remote to local", () => {
    expect(resolveDrop(payload(), "local", "C:\\Downloads")).toEqual({
      kind: "transfer",
      direction: "download",
      from: "/home/user/a.txt",
      to: "C:\\Downloads\\a.txt",
    });
  });

  it("does not drop a folder into itself or across panes", () => {
    const folder = payload({ isDir: true, path: "/home/user/docs", name: "docs" });
    expect(resolveDrop(folder, "remote", "/home/user/docs")).toEqual({ kind: "noop" });
    expect(resolveDrop(folder, "local", "C:\\\\work")).toEqual({ kind: "noop" });
  });
});

describe("planPaste", () => {
  const clip = (overrides: Partial<PasteClip> = {}): PasteClip => ({
    side: "remote",
    action: "copy",
    path: "/home/user/a.txt",
    name: "a.txt",
    isDir: false,
    ...overrides,
  });

  it("copies inside the same pane", () => {
    expect(planPaste(clip(), "remote", "/home/user/docs")).toEqual({
      kind: "copy",
      from: "/home/user/a.txt",
      to: "/home/user/docs/a.txt",
    });
  });

  it("moves when the entry was cut", () => {
    expect(planPaste(clip({ action: "cut" }), "remote", "/home/user/docs")).toEqual({
      kind: "move",
      from: "/home/user/a.txt",
      to: "/home/user/docs/a.txt",
    });
  });

  it("uploads and downloads across panes", () => {
    expect(planPaste(clip({ side: "local", path: "C:\\tmp\\a.txt" }), "remote", "/home/user")).toEqual({
      kind: "transfer",
      direction: "upload",
      from: "C:\\tmp\\a.txt",
      to: "/home/user/a.txt",
    });
    expect(planPaste(clip(), "local", "C:\\work")).toEqual({
      kind: "transfer",
      direction: "download",
      from: "/home/user/a.txt",
      to: "C:\\work\\a.txt",
    });
  });

  it("copies folders inside a pane and ignores cross-pane folders", () => {
    expect(planPaste(clip(), "remote", "/home/user")).toEqual({ kind: "noop" });
    expect(planPaste(clip({ isDir: true }), "remote", "/home/user/docs")).toEqual({
      kind: "copy",
      from: "/home/user/a.txt",
      to: "/home/user/docs/a.txt",
    });
    expect(planPaste(clip({ isDir: true }), "local", "C:\\\\work")).toEqual({ kind: "noop" });
  });
});
describe("canPaste", () => {
  const clip: PasteClip = {
    side: "remote",
    action: "copy",
    path: "/home/user/a.txt",
    name: "a.txt",
    isDir: false,
  };

  it("rejects empty clipboards and no-op targets", () => {
    expect(canPaste(null, "remote", "/home/user/docs")).toBe(false);
    expect(canPaste(clip, "remote", "/home/user")).toBe(false);
  });

  it("accepts another folder and the other pane", () => {
    expect(canPaste(clip, "remote", "/home/user/docs")).toBe(true);
    expect(canPaste(clip, "local", "C:\\work")).toBe(true);
  });
});