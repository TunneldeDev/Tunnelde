// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { decodeBase64, decodeBase64Text, encodeBase64 } from "@/lib/base64";

describe("base64 transport", () => {
  it("round trips ascii", () => {
    const encoded = encodeBase64("ls -la\n");
    expect(decodeBase64Text(encoded)).toBe("ls -la\n");
  });

  it("round trips multi-byte text", () => {
    const text = "echo 你好 · ✓";
    expect(decodeBase64Text(encodeBase64(text))).toBe(text);
  });

  it("returns bytes for the terminal", () => {
    const bytes = decodeBase64(encodeBase64("abc"));
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
  });

  it("handles long input without throwing", () => {
    const text = "x".repeat(140_000);
    expect(decodeBase64(encodeBase64(text)).length).toBe(140_000);
  });
});
