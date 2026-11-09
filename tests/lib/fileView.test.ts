import { describe, expect, it } from "vitest";

import type { FileEntry } from "@/lib/api/types";
import {
  createFileViewSelector,
  createGroupedFileViewSelector,
  visibleFiles,
  type FileViewPreferences,
} from "@/lib/files/view";

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
  it("combines qualifiers with local millisecond timestamps and explicit hidden-file requests", () => {
    const entries = [
      entry("report.json", { size: 4096, modified: new Date(2026, 10, 9, 12).getTime() }),
      entry(".env"),
      entry("folder", { isDir: true }),
    ];
    const filter = (query: string) =>
      names(visibleFiles(entries, preferences, collator, [], { query, kind: "all" }));
    expect(filter("@ext:json @size:>=4KiB @modified:2026-11-09")).toEqual(["report.json"]);
    expect(filter("@is:hidden")).toEqual([".env"]);
    expect(filter("@type:folder")).toEqual(["folder"]);
    expect(filter("-@ext:json")).toEqual(["folder"]);
  });
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

  it("combines Chinese and case insensitive name matching with item type", () => {
    const entries = [
      entry("中文Report.TXT"),
      entry("中文report", { isDir: true }),
      entry("else.txt"),
    ];
    expect(
      names(
        visibleFiles(entries, preferences, collator, [], { query: "中文rEpOrT", kind: "files" }),
      ),
    ).toEqual(["中文Report.TXT"]);
    expect(
      names(visibleFiles(entries, preferences, collator, [], { query: "中文", kind: "folders" })),
    ).toEqual(["中文report"]);
  });

  it("folds complete type groups and reveals a changed file despite type and name filters", () => {
    const select = createGroupedFileViewSelector();
    const entries = [
      entry("file10.txt"),
      entry("file2.txt"),
      entry("folder", { isDir: true }),
      entry(".env"),
    ];
    const view = { ...preferences, filesGroupBy: "type" as const };
    const folded = select(entries, view, collator, [], { query: "", kind: "all" }, [
      "extension:txt",
    ]);
    expect(folded.groups.map((group) => [group.key, group.entries.length])).toEqual([
      ["folders", 1],
      ["extension:txt", 2],
    ]);
    expect(names(folded.entries)).toEqual(["folder"]);
    const revealed = select(
      entries,
      view,
      collator,
      ["/work/file2.txt"],
      { query: "none", kind: "folders" },
      ["extension:txt"],
    );
    expect(names(revealed.entries)).toEqual(["file2.txt"]);
    expect(revealed.groups[0]?.collapsed).toBe(false);
  });

  it("groups local calendar dates newest first, keeps unknown last and first characters Unicode aware", () => {
    const select = createGroupedFileViewSelector();
    const entries = [
      entry("中文", { modified: new Date(2026, 10, 2, 2).getTime() }),
      entry("2file", { modified: new Date(2026, 10, 1, 23).getTime() }),
      entry("#file"),
    ];
    expect(
      select(entries, { ...preferences, filesGroupBy: "modified" }, collator).groups.map(
        (group) => group.key,
      ),
    ).toEqual(["2026-11-02", "2026-11-01", "unknown"]);
    expect(
      new Set(
        select(entries, { ...preferences, filesGroupBy: "initial" }, collator).groups.map(
          (group) => group.key,
        ),
      ),
    ).toEqual(new Set(["中", "0–9", "#"]));
  });
});
