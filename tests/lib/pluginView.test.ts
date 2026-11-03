import { describe, expect, it } from "vitest";

import { normalizeBlocks, normalizeResult, viewTitle } from "@/lib/plugins/pluginView";

describe("normalizeBlocks", () => {
  it("mount controls are native, unique and discard plugin-supplied executable fields", () => {
    expect(
      normalizeBlocks([{ type: "mounts", command: "unsafe", owner: "other" }, { type: "mounts" }]),
    ).toEqual([{ type: "mounts" }]);
  });
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

  it("normalizes interactive forms without accepting duplicate ids or executable content", () => {
    const form = {
      type: "form",
      id: "tool",
      fields: [
        { id: "source", type: "textarea", label: "Source", value: "  a\n  " },
        { id: "source", type: "text", label: "Duplicate" },
        { id: "constructor", type: "text", label: "Unsafe" },
        { id: "html", type: "html", label: "Unsupported" },
        {
          id: "unit",
          type: "select",
          label: "Unit",
          value: "bad",
          options: [
            { value: "s", label: "Seconds" },
            { value: "s", label: "Duplicate" },
          ],
        },
      ],
      actions: [
        { id: "run", label: "Run", command: "run" },
        { id: "run", label: "Again", command: "run" },
      ],
    };
    const blocks = normalizeBlocks([form, form]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "form",
      fields: [
        { id: "source", value: "  a\n  " },
        { id: "unit", value: "s", options: [{ value: "s", label: "Seconds" }] },
      ],
      actions: [{ id: "run", label: "Run", command: "run" }],
    });
  });

  it("preserves large result formatting and rejects oversized output without silent truncation", () => {
    const source = "  " + "x".repeat(12000) + "\n";
    expect(normalizeResult({ text: source, title: "Output" })).toEqual({
      text: source,
      title: "Output",
      error: false,
    });
    expect(normalizeResult({ text: "Failure", error: true }).error).toBe(true);
    expect(normalizeResult({ legacy: "value" }).text).toBe('{\n  "legacy": "value"\n}');
    expect(() => normalizeResult({ text: "中".repeat(400000) })).toThrow("resultTooLarge");
  });
});
