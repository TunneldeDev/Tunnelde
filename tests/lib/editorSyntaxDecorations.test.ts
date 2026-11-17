import { describe, expect, it } from "vitest";
import {
  absoluteSyntaxDecorations,
  syntaxDecorationClass,
} from "@/features/editor/syntax/syntaxDecorations";

describe("CodeMirror syntax decoration projection", () => {
  it("translates validated window-local tokens to absolute UTF-16 offsets", () => {
    expect(
      absoluteSyntaxDecorations({
        documentId: "doc",
        version: 4,
        offset: 100,
        length: 20,
        tokens: [
          { start: 0, end: 5, type: "keyword" },
          { start: 10, end: 12, type: "number" },
        ],
      }),
    ).toEqual([
      { start: 100, end: 105, type: "keyword" },
      { start: 110, end: 112, type: "number" },
    ]);
  });

  it("drops out-of-window, overlapping and malformed ranges without plugin styles", () => {
    expect(
      absoluteSyntaxDecorations({
        documentId: "doc",
        version: 4,
        offset: 50,
        length: 10,
        tokens: [
          { start: 0, end: 4, type: "string" },
          { start: 2, end: 6, type: "keyword" },
          { start: 9, end: 11, type: "comment" },
          { start: 8, end: 9, type: "function" },
        ],
      }),
    ).toEqual([
      { start: 50, end: 54, type: "string" },
      { start: 58, end: 59, type: "function" },
    ]);
    expect(syntaxDecorationClass("keyword")).toBe("cm-editor-token-keyword");
  });
});
