import { describe, expect, it } from "vitest";

import {
  indexFileHighlights,
  resolveFileHighlight,
  type FileHighlightSnapshot,
} from "@/lib/plugins/fileHighlights";

describe("file highlight contribution snapshots", () => {
  it("accepts detached native DTOs with semantic tones and null optional fields", () => {
    const snapshot: FileHighlightSnapshot = {
      revision: 3,
      items: [
        {
          id: "generated",
          priority: 10,
          source: "local",
          pluginId: "generator",
          pluginName: "Generator",
          highlights: [
            { match: { extension: "ts" }, tooltip: null, tone: "info" },
            { match: { name: "README.md" }, tooltip: "Read me", tone: "warning" },
            { match: { pathPrefix: "/generated/" }, tooltip: "Generated", tone: "success" },
          ],
        },
      ],
    };
    const index = indexFileHighlights(snapshot.items);
    expect(index.get("local")).toHaveLength(3);
    expect(index.get("local")?.every((item) => item.pluginId === "generator")).toBe(true);
    expect(Object.isFrozen(index.get("local")?.[0])).toBe(true);
    expect(Object.isFrozen(index.get("local")?.[0]?.match)).toBe(true);
    expect(resolveFileHighlight(index, "local", "/work/a.ts", "a.ts", false)).toMatchObject({
      tone: "info",
      tooltip: null,
    });
    expect(
      resolveFileHighlight(index, "local", "/work/README.md", "README.md", false),
    ).toMatchObject({
      tone: "warning",
    });
    expect(resolveFileHighlight(index, "local", "/generated/a.js", "a.js", false)).toMatchObject({
      tone: "success",
    });
  });

  it("does not interpret plugin text as markup", () => {
    const index = indexFileHighlights([
      {
        id: "safe",
        priority: 0,
        source: "local",
        pluginId: "plugin",
        pluginName: "<img src=x>",
        highlights: [{ match: { name: "a.txt" }, tooltip: "<script>x</script>", tone: "error" }],
      },
    ]);
    const item = resolveFileHighlight(index, "local", "/a.txt", "a.txt", false)!;
    expect(item.pluginName).toBe("<img src=x>");
    expect(item.tooltip).toBe("<script>x</script>");
  });
});
