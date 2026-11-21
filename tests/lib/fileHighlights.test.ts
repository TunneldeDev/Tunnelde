import { describe, expect, it } from "vitest";

import {
  fileHighlightLabel,
  fileHighlightSource,
  indexFileHighlights,
  resolveFileHighlight,
  type FileHighlightSet,
} from "@/lib/plugins/fileHighlights";

const set = (overrides: Partial<FileHighlightSet> = {}): FileHighlightSet => ({
  id: "generated",
  priority: 0,
  source: "",
  pluginId: "plugin",
  pluginName: "Plugin",
  highlights: [
    { match: { extension: "ts" }, tooltip: "TypeScript", tone: "info" },
    { match: { name: "README.md" }, tooltip: "Read me", tone: "warning" },
    { match: { pathPrefix: "/srv/generated" }, tooltip: "Generated tree", tone: "success" },
  ],
  ...overrides,
});

describe("plugin file highlights", () => {
  it("resolves source-specific rules before global rules and matches one semantic predicate", () => {
    const index = indexFileHighlights([
      set(),
      set({
        id: "remote",
        source: "remote-1",
        priority: 10,
        pluginId: "specific",
        pluginName: "Specific",
        highlights: [{ match: { extension: "TS" }, tooltip: "Remote TS", tone: "error" }],
      }),
    ]);
    expect(resolveFileHighlight(index, "remote-1", "/work/a.ts", "a.ts", false)).toMatchObject({
      pluginId: "specific",
      tone: "error",
    });
    expect(resolveFileHighlight(index, "remote-2", "/work/a.ts", "a.ts", false)).toMatchObject({
      pluginId: "plugin",
      tone: "info",
    });
    expect(
      resolveFileHighlight(index, "remote-1", "/work/README.md", "README.md", false),
    ).toMatchObject({
      pluginId: "plugin",
      tone: "warning",
    });
    expect(resolveFileHighlight(index, "remote-1", "/srv/generated/a", "a", false)).toMatchObject({
      pluginId: "plugin",
      tone: "success",
    });
    expect(resolveFileHighlight(index, "remote-1", "/work/a.ts", "a.ts", true)).toBeNull();
  });

  it("indexes deterministically and keeps plugin identity in accessible labels", () => {
    const first = set({ priority: 5, pluginId: "b", pluginName: "Beta" });
    const second = set({ priority: 5, pluginId: "a", pluginName: "Alpha" });
    const index = indexFileHighlights([first, second]);
    const item = resolveFileHighlight(index, "local", "/a.ts", "a.ts", false)!;
    expect(item.pluginId).toBe("a");
    expect(fileHighlightLabel(item)).toBe("Alpha · TypeScript");
    expect(fileHighlightSource({ kind: "local" })).toBe("local");
    expect(fileHighlightSource({ kind: "remote", sessionId: "remote-1" })).toBe("remote-1");
  });

  it("accepts a remote: source prefix as the same session identity", () => {
    const index = indexFileHighlights([
      set({
        source: "remote-1",
        highlights: [{ match: { name: "a.ts" }, tooltip: null, tone: "success" }],
      }),
    ]);
    expect(resolveFileHighlight(index, "remote-1", "/a.ts", "a.ts", false)).toMatchObject({
      tone: "success",
    });
  });

  it("scopes a collection to one listing directory without affecting other folders", () => {
    const index = indexFileHighlights([
      set({
        directory: "/srv/app",
        highlights: [{ match: { extension: "txt" }, tooltip: null, tone: "warning" }],
      }),
    ]);
    expect(
      resolveFileHighlight(index, "local", "/srv/app/a.txt", "a.txt", false, "/srv/app"),
    ).toMatchObject({
      tone: "warning",
    });
    expect(
      resolveFileHighlight(index, "local", "/srv/other/a.txt", "a.txt", false, "/srv/other"),
    ).toBeNull();
  });
});
