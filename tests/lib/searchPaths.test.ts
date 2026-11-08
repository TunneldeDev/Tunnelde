import { describe, expect, it } from "vitest";
import { inSearchRoot, searchParent, searchPathKey } from "@/lib/files/searchPaths";

describe("search paths", () => {
  it.each([
    ["C:\\work\\a.txt", null, "C:\\work"],
    ["C:/work/a.txt", null, "C:/work"],
    ["C:\\a.txt", null, "C:\\"],
    ["C:/a.txt", null, "C:/"],
    ["\\\\server\\share\\a.txt", null, "\\\\server\\share"],
    ["//server/share/a.txt", null, "//server/share"],
    ["/work/a.txt", null, "/work"],
    ["/work/a\\b.txt", null, "/work"],
    ["/work/a\\b.txt", "ssh", "/work"],
    ["/a.txt", "ssh", "/"],
  ])("finds the parent of %s", (path, sessionId, expected) => {
    expect(searchParent(path!, sessionId)).toBe(expected);
  });

  it("compares local Windows and UNC aliases without changing POSIX or remote names", () => {
    expect(searchPathKey("C:\\WORK\\a.txt", null)).toBe(searchPathKey("c:/work/a.txt", null));
    expect(searchPathKey("\\\\SERVER\\Share\\a.txt", null)).toBe(
      searchPathKey("//server/share/a.txt", null),
    );
    expect(searchPathKey("/work/A.txt", null)).not.toBe(searchPathKey("/work/a.txt", null));
    expect(searchPathKey("/work/a\\b.txt", "ssh")).not.toBe(searchPathKey("/work/a/b.txt", "ssh"));
    expect(searchPathKey("/work/A.txt", "ssh")).not.toBe(searchPathKey("/work/a.txt", "ssh"));
  });

  it("requires a directory boundary, retaining local drive and remote roots", () => {
    expect(inSearchRoot("C:\\WORK\\a.txt", "c:/work/", null)).toBe(true);
    expect(inSearchRoot("C:\\work2\\a.txt", "c:/work", null)).toBe(false);
    expect(inSearchRoot("C:\\a.txt", "C:/", null)).toBe(true);
    expect(inSearchRoot("/a.txt", "/", "ssh")).toBe(true);
    expect(inSearchRoot("/work\\literal/a.txt", "/work\\literal", "ssh")).toBe(true);
    expect(inSearchRoot("/work/literal/a.txt", "/work\\literal", "ssh")).toBe(false);
  });
});
