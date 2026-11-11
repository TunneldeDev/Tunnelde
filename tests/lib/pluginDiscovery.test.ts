import { expect, it } from "vitest";
import { matchesPlugin, pluginTags, togglePluginTag } from "@/lib/plugins/discovery";

it("combines search words and exact tag filters without executing a plugin", () => {
  const plugin = {
    id: "preview",
    name: "File Preview",
    description: "Remote media",
    tags: ["PDF", "pdf", "media"],
  };
  expect(pluginTags(plugin)).toEqual(["pdf", "media"]);
  expect(matchesPlugin(plugin, "remote preview", "pdf")).toBe(true);
  expect(matchesPlugin(plugin, "@tag:pdf file", "media")).toBe(true);
  expect(matchesPlugin(plugin, "@tag:pd", "")).toBe(false);
  expect(matchesPlugin(plugin, "tag:pdf", "")).toBe(false);
  expect(matchesPlugin(plugin, "name:File Preview", "")).toBe(false);
  expect(matchesPlugin({ ...plugin, name: "tag:pdf" }, "tag:pdf", "")).toBe(true);
  expect(matchesPlugin(plugin, "@tag:icons,pdf preview", "")).toBe(true);
  expect(matchesPlugin(plugin, "@tag:icons,tools preview", "")).toBe(false);
  expect(matchesPlugin(plugin, "", "icons")).toBe(false);
  expect(matchesPlugin({ id: "old", name: "Legacy" }, "legacy", "")).toBe(true);
});

it("edits quoted plugin tags without corrupting literal text or repeated conditions", () => {
  const query = togglePluginTag('"@tag:literal" @tag:tools', "logs, JSON");
  expect(matchesPlugin({ id: "log", name: "@tag:literal", tags: ["logs, json"] }, query, "")).toBe(
    true,
  );
  expect(togglePluginTag(query, "LOGS, json")).toBe('"@tag:literal" @tag:tools');
});
