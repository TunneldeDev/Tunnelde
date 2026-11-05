import { expect, it } from "vitest";
import { matchesPlugin, pluginTags } from "@/lib/plugins/discovery";

it("combines search words and exact tag filters without executing a plugin", () => {
  const plugin = {
    id: "preview",
    name: "File Preview",
    description: "Remote media",
    tags: ["PDF", "pdf", "media"],
  };
  expect(pluginTags(plugin)).toEqual(["pdf", "media"]);
  expect(matchesPlugin(plugin, "remote preview", "pdf")).toBe(true);
  expect(matchesPlugin(plugin, "tag:pdf file", "media")).toBe(true);
  expect(matchesPlugin(plugin, "tag:pd", "")).toBe(false);
  expect(matchesPlugin(plugin, "tag:icons,pdf preview", "")).toBe(true);
  expect(matchesPlugin(plugin, "tag:icons,tools preview", "")).toBe(false);
  expect(matchesPlugin(plugin, "", "icons")).toBe(false);
  expect(matchesPlugin({ id: "old", name: "Legacy" }, "legacy", "")).toBe(true);
});
