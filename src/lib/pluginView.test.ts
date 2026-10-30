// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { normalizeBlocks, viewTitle } from "@/lib/pluginView";

describe("normalizeBlocks", () => {
  it("keeps known blocks in order", () => {
    const blocks = normalizeBlocks([
      { type: "heading", text: "Title" },
      { type: "text", text: "Body" },
      { type: "kv", items: [{ label: "a", value: "1" }] },
      { type: "table", columns: ["x", "y"], rows: [["1", "2"]] },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["heading", "text", "kv", "table"]);
  });

  it("drops unknown and malformed blocks", () => {
    const blocks = normalizeBlocks([
      { type: "button", text: "nope" },
      null,
      "string",
      { type: "heading" },
      { type: "table", columns: [], rows: [] },
      { type: "kv", items: [] },
    ]);
    expect(blocks).toEqual([]);
  });

  it("pads and trims table rows to the column count", () => {
    const [table] = normalizeBlocks([
      { type: "table", columns: ["a", "b"], rows: [["1"], ["1", "2", "3"]] },
    ]);
    expect(table).toEqual({
      type: "table",
      columns: ["a", "b"],
      rows: [
        ["1", ""],
        ["1", "2"],
      ],
    });
  });

  it("caps oversized input", () => {
    const blocks = normalizeBlocks(
      Array.from({ length: 200 }, (_, index) => ({ type: "text", text: `line ${index}` })),
    );
    expect(blocks).toHaveLength(100);
  });

  it("reads the optional title", () => {
    expect(viewTitle({ title: "Panel" })).toBe("Panel");
    expect(viewTitle(null)).toBe("");
    expect(viewTitle({ title: 42 })).toBe("");
  });
});
