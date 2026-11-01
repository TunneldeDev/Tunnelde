import { afterEach, describe, expect, it, vi } from "vitest";

import catalogue from "../../marketplace/index.json";
import { fetchMarketplace } from "@/lib/plugins/marketplace";

const example = {
  id: "hello",
  name: "Hello",
  version: "0.1.0",
  description: "SDK example",
  url: "https://github.com/TunneldeDev/Tunnelde/releases/download/v0.14.1/hello-plugin.zip",
  sha256: "a".repeat(64),
};

afterEach(() => vi.unstubAllGlobals());

describe("production marketplace", () => {
  it("accepts theme catalogues and rejects unknown executable runtimes", async () => {
    const theme = {
      ...example,
      id: "theme-pack",
      runtime: "theme",
      url: "https://plugins.example.org/themes.zip",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ plugins: [theme, { ...theme, runtime: "shell" }] }),
        }),
    );
    expect(await fetchMarketplace()).toEqual([theme]);
  });
  it("ships independently installable utility plugins with versioned release archives and checksums", () => {
    expect(catalogue.plugins.map((entry) => entry.id).sort()).toEqual([
      "json-formatter",
      "studio-themes",
      "timestamp",
      "uuid",
    ]);
    for (const entry of catalogue.plugins) {
      expect(entry.name).toBeTruthy();
      expect(entry.runtime).toBe(entry.id === "studio-themes" ? "theme" : "node");
      expect(entry.apiVersion).toBe(1);
      expect(entry.url).toBe(
        `https://github.com/TunneldeDev/tunnelde-hub/releases/download/plugins-v${entry.version}/${entry.id}-${entry.version}.zip`,
      );
      expect(entry.sha256).toMatch(/^[a-f\d]{64}$/);
      expect(entry.id).not.toBe("hello");
    }
  });

  it("removes the historical official SDK artifact while retaining unrelated Hello plugins", async () => {
    const unrelated = {
      ...example,
      url: "https://github.com/another/publisher/releases/download/v1/hello-plugin.zip",
    };
    const custom = { ...example, id: "my-plugin", url: "https://plugins.example.org/hello.zip" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ plugins: [example, unrelated, custom] }),
      }),
    );
    expect(await fetchMarketplace()).toEqual([unrelated, custom]);
  });

  it("ignores malformed catalogue entries without breaking the whole marketplace", async () => {
    const valid = { ...example, id: "production", url: "https://plugins.example.org/plugin.zip" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          plugins: [null, {}, { ...valid, sha256: "bad" }, { ...valid, url: "https://" }, valid],
        }),
      }),
    );
    expect(await fetchMarketplace()).toEqual([valid]);
  });
});
