import { describe, expect, it } from "vitest";
import type { FileEntry, Listing } from "@/lib/api/types";
import { columnAncestors, pathCrumbs } from "@/lib/files/navigation";
import { typeSelect } from "@/lib/files/typeSelect";
import { sampleTransfer, transferProgress } from "@/lib/files/transferProgress";

const entry = (name: string, directory = false): FileEntry => ({
  name,
  path: `/root/${name}`,
  isDir: directory,
  isHidden: false,
  size: 0,
  modified: null,
  permissions: null,
});

describe("file navigation", () => {
  it("preserves Windows drive, UNC and POSIX roots in breadcrumb paths", () => {
    expect(pathCrumbs("C:\\work\\src", { kind: "local" }).map((item) => item.path)).toEqual([
      "C:\\",
      "C:\\work",
      "C:\\work\\src",
    ]);
    expect(
      pathCrumbs("\\\\server\\share\\folder", { kind: "local" }).map((item) => item.path),
    ).toEqual(["\\\\server\\share\\", "\\\\server\\share\\folder"]);
    expect(
      pathCrumbs("/home/a\\b", { kind: "remote", sessionId: "ssh" }).map((item) => item.path),
    ).toEqual(["/", "/home", "/home/a\\b"]);
  });

  it("preserves ancestors only for a known child and truncates a changed branch", () => {
    const root: Listing = { path: "/root", entries: [entry("first", true), entry("second", true)] };
    const first: Listing = { path: "/root/first", entries: [] };
    const second: Listing = { path: "/root/second", entries: [] };
    expect(columnAncestors([], root, first)).toEqual([root]);
    expect(columnAncestors([root], first, second)).toEqual([root]);
    expect(columnAncestors([root], first, root)).toEqual([]);
    expect(columnAncestors([root], first, { path: "/elsewhere", entries: [] })).toEqual([]);
  });

  it("uses complete repeated prefixes, Chinese input and a fresh scope after navigation", () => {
    const entries = [entry("yak"), entry("yy.exe"), entry("xyc.exe"), entry("微信-Installer.exe")];
    const first = typeSelect(entries, "y", null, undefined, "folder", 0, "zh-CN");
    expect(first.path).toBe("/root/yak");
    expect(typeSelect(entries, "y", first.path, first.state, "folder", 200, "zh-CN").path).toBe(
      "/root/yy.exe",
    );
    const x = typeSelect(entries, "x", null, undefined, "folder", 0, "zh-CN");
    expect(typeSelect(entries, "y", x.path, x.state, "folder", 200, "zh-CN").path).toBe(
      "/root/xyc.exe",
    );
    expect(typeSelect(entries, "微信", null, undefined, "folder", 0, "zh-CN").path).toBe(
      "/root/微信-Installer.exe",
    );
    expect(typeSelect(entries, "y", x.path, x.state, "other", 200, "zh-CN").path).toBe("/root/yak");
    expect(typeSelect(entries, "y", x.path, x.state, "folder", 1500, "zh-CN").path).toBe(
      "/root/yak",
    );
  });
});

describe("transfer throughput", () => {
  it("does not count resumed bytes and expires stalled throughput", () => {
    const baseline = sampleTransfer(undefined, 1000, 0);
    const rate = sampleTransfer(baseline, 1200, 1000);
    const item = { status: "running", transferred: 1200, total: 2000, rate };
    expect(transferProgress(item, 1000)).toMatchObject({
      speed: 200,
      remaining: 800,
      eta: 4,
      percent: 60,
    });
    expect(transferProgress(item, 6000)).toMatchObject({ speed: 0, eta: null });
  });

  it("represents unknown totals and completed empty files without invalid percentages", () => {
    expect(transferProgress({ status: "running", transferred: 0, total: 0 }, 1)).toMatchObject({
      total: null,
      percent: null,
      eta: null,
    });
    expect(transferProgress({ status: "done", transferred: 0, total: 0 }, 1)).toMatchObject({
      total: 0,
      remaining: 0,
      percent: 100,
    });
  });
});
