import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMarketplace, MARKETPLACE_INDEX_URL } from "@/lib/plugins/marketplace";

const example = {
  id: "sample",
  name: "Sample",
  version: "0.1.0",
  description: "Sample plugin",
  url: "https://plugins.example.org/sample.zip",
  sha256: "a".repeat(64),
};

afterEach(() => vi.unstubAllGlobals());

describe("production marketplace", () => {
  it("uses only the independent official hub catalogue", () => {
    expect(MARKETPLACE_INDEX_URL).toBe(
      "https://raw.githubusercontent.com/TunneldeDev/tunnelde-hub/main/registry.json",
    );
  });

  it("accepts theme catalogues and rejects unknown executable runtimes", async () => {
    const theme = {
      ...example,
      id: "theme-pack",
      runtime: "theme",
      url: "https://plugins.example.org/themes.zip",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ plugins: [theme, { ...theme, runtime: "shell" }] }),
      }),
    );
    expect(await fetchMarketplace()).toEqual([theme]);
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
