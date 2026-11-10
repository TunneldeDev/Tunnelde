import { describe, expect, it } from "vitest";
import { sourceHosts, savedHostInput, type HostSourcesSnapshot } from "@/lib/hosts/sources";
import { matchesHostQuery, parseHostQuery } from "@/lib/hosts/query";
import { buildHostTree } from "@/lib/hosts/tree";

const snapshot: HostSourcesSnapshot = {
  revision: 1,
  items: [
    {
      pluginId: "inventory",
      pluginName: "Inventory provider",
      id: "cloud",
      label: "Cloud nodes",
      entries: [
        {
          id: "one",
          hostId: "source:digest",
          name: "Node",
          host: "192.0.2.1",
          username: "qa",
          tags: ["prod"],
        },
      ],
    },
  ],
};
describe("discovered hosts", () => {
  it("uses authoritative endpoint IDs, clones metadata, and explicitly saves an independent copy", () => {
    const host = sourceHosts(snapshot)[0]!;
    expect(host.id).toBe("source:digest");
    expect(host.source).toEqual({
      pluginId: "inventory",
      pluginName: "Inventory provider",
      id: "cloud",
      label: "Cloud nodes",
      entryId: "one",
    });
    expect(host.authMethod).toBe("password");
    expect(host.keyPath).toBeNull();
    host.tags.push("local");
    expect(snapshot.items[0]!.entries[0]!.tags).toEqual(["prod"]);
    const copy = savedHostInput(host);
    expect(copy).not.toHaveProperty("source");
    expect(copy).not.toHaveProperty("id");
    expect(copy.host).toBe(host.host);
    copy.tags!.push("copy");
    expect(host.tags).not.toContain("copy");
  });
  it("groups discovery separately and requires @ for source and plugin filters", () => {
    const host = sourceHosts(snapshot)[0]!;
    for (const query of [
      "@source:cloud",
      '@source:"Cloud nodes"',
      "@plugin:inventory",
      "@is:discovered",
    ])
      expect(matchesHostQuery(host, parseHostQuery(query))).toBe(true);
    for (const query of ["source:cloud", "plugin:inventory", "@is:saved", "-@plugin:inventory"])
      expect(matchesHostQuery(host, parseHostQuery(query))).toBe(false);
    const saved = { ...host, id: "saved", source: undefined };
    const tree = buildHostTree([], [saved, host], "");
    expect(tree.ungrouped).toEqual([saved]);
    expect(tree.sources[0]!.hosts).toEqual([host]);
    expect(tree.sources[0]!.group.name).toBe("Cloud nodes · Inventory provider");
    expect(buildHostTree([], [saved, host], "@is:saved").sources).toEqual([]);
  });
});
