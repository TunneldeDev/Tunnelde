// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

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
  it("ships an empty production catalogue until real plugins are published", () => {
    expect(catalogue.plugins).toEqual([]);
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
