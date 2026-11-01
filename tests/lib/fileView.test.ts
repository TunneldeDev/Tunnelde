import { describe, expect, it } from "vitest";

import type { FileEntry } from "@/lib/api/types";
import { createFileViewSelector, visibleFiles, type FileViewPreferences } from "@/lib/files/view";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const preferences: FileViewPreferences = {
  filesShowHidden: false,
  filesFoldersFirst: true,
  filesSortBy: "name",
  filesSortDirection: "asc",
};
const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/work/${name}`,
  isDir: false,
  isHidden: false,
  size: 0,
  modified: null,
  permissions: null,
  ...extra,
});
const names = (entries: FileEntry[]) => entries.map((item) => item.name);

describe("file list views", () => {
  it("hides dotfiles and platform hidden attributes without mutating raw metadata", () => {
    const entries = [entry("visible"), entry(".env"), entry("system", { isHidden: true })];
    expect(names(visibleFiles(entries, preferences, collator))).toEqual(["visible"]);
    expect(
      names(visibleFiles(entries, { ...preferences, filesShowHidden: true }, collator)),
    ).toEqual([".env", "system", "visible"]);
    expect(entries.map((item) => item.name)).toEqual(["visible", ".env", "system"]);
  });

  it("reveals an explicitly created hidden file without exposing other hidden entries", () => {
    const entries = [entry(".env"), entry(".git"), entry("visible")];
    expect(names(visibleFiles(entries, preferences, collator, ["/work/.env"]))).toEqual([
      ".env",
      "visible",
    ]);
    expect(preferences.filesShowHidden).toBe(false);
  });

  it("sorts numeric names naturally and keeps folders first when descending", () => {
    const entries = [
      entry("file10"),
      entry("folder2", { isDir: true }),
      entry("file2"),
      entry("folder10", { isDir: true }),
    ];
    expect(names(visibleFiles(entries, preferences, collator))).toEqual([
      "folder2",
      "folder10",
      "file2",
      "file10",
    ]);
    expect(
      names(visibleFiles(entries, { ...preferences, filesSortDirection: "desc" }, collator)),
    ).toEqual(["folder10", "folder2", "file10", "file2"]);
    expect(
      names(visibleFiles(entries, { ...preferences, filesFoldersFirst: false }, collator)),
    ).toEqual(["file2", "file10", "folder2", "folder10"]);
  });

  it("uses deterministic ascending name ties for size sorting", () => {
    const entries = [
      entry("file10", { size: 5 }),
      entry("small", { size: 1 }),
      entry("file2", { size: 5 }),
    ];
    expect(
      names(
        visibleFiles(
          entries,
          { ...preferences, filesSortBy: "size", filesSortDirection: "desc" },
          collator,
        ),
      ),
    ).toEqual(["file2", "file10", "small"]);
  });

  it.each(["asc", "desc"] as const)("keeps unknown timestamps last with %s dates", (direction) => {
    const entries = [
      entry("unknown"),
      entry("older", { modified: 1 }),
      entry("newer", { modified: 2 }),
    ];
    expect(
      names(
        visibleFiles(
          entries,
          { ...preferences, filesSortBy: "modified", filesSortDirection: direction },
          collator,
        ),
      ),
    ).toEqual(direction === "asc" ? ["older", "newer", "unknown"] : ["newer", "older", "unknown"]);
  });

  it("reuses one sorted view across rendering and interactions until its inputs change", () => {
    const select = createFileViewSelector();
    const entries = [entry("file10"), entry("file2")];
    const first = select(entries, preferences, collator);
    expect(select(entries, { ...preferences }, collator)).toBe(first);
    expect(select(entries, { ...preferences, filesSortDirection: "desc" }, collator)).not.toBe(
      first,
    );
  });
});
