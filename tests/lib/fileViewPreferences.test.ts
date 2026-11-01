import { beforeEach, describe, expect, it } from "vitest";
import {
  fileViewPreferenceKey,
  readFileViewPreferences,
  writeFileViewPreferences,
} from "@/lib/files/preferences";
import type { FileViewPreferences } from "@/lib/files/view";

const defaults: FileViewPreferences = {
  filesShowHidden: false,
  filesFoldersFirst: true,
  filesSortBy: "name",
  filesSortDirection: "asc",
};
beforeEach(() => localStorage.clear());
describe("file panel preferences", () => {
  it("separates window, owning tab, panel slot and selected source", () => {
    const key = fileViewPreferenceKey("main", "host:a", "a", "local");
    writeFileViewPreferences(key, { ...defaults, filesShowHidden: true });
    expect(readFileViewPreferences(key, defaults).filesShowHidden).toBe(true);
    for (const tuple of [
      ["other", "host:a", "a", "local"],
      ["main", "host:b", "a", "local"],
      ["main", "host:a", "b", "local"],
      ["main", "host:a", "a", "host:c"],
    ]) {
      expect(
        readFileViewPreferences(
          fileViewPreferenceKey(tuple[0]!, tuple[1]!, tuple[2]!, tuple[3]!),
          defaults,
        ).filesShowHidden,
      ).toBe(false);
    }
  });
  it("rejects invalid stored fields and bounds accumulated host preferences", () => {
    const key = fileViewPreferenceKey("main", "host:a", "a", "local");
    localStorage.setItem(
      key,
      JSON.stringify({
        view: { filesShowHidden: "false", filesSortBy: "invalid", filesSortDirection: "invalid" },
      }),
    );
    expect(readFileViewPreferences(key, defaults)).toEqual({ ...defaults, filesGroupBy: "none" });
    for (let index = 0; index < 140; index++)
      writeFileViewPreferences(
        fileViewPreferenceKey("main", `host:${index}`, "a", "local"),
        defaults,
      );
    expect(
      Object.keys(localStorage).filter((item) => item.startsWith("tunnelde:file-view:v1:")).length,
    ).toBeLessThanOrEqual(128);
  });
});
