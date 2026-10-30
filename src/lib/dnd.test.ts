// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { joinPath, parentOf, resolveDrop, type DragPayload } from "@/lib/dnd";

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

  it("does not drop a folder into itself", () => {
    const folder = payload({ isDir: true, path: "/home/user/docs", name: "docs" });
    expect(resolveDrop(folder, "remote", "/home/user/docs")).toEqual({ kind: "noop" });
  });
});
