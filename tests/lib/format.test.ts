// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { formatBytes, formatUptime, hostSubtitle, parseTags } from "@/lib/text/format";

describe("formatBytes", () => {
  it("handles empty values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("scales to the right unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });
});

describe("formatUptime", () => {
  it("prints the two largest units", () => {
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatUptime(2 * 86_400 + 5 * 3600)).toBe("2d 5h");
  });
});

describe("parseTags", () => {
  it("trims, drops empties and dedups", () => {
    expect(parseTags(" web , , eu ,web ")).toEqual(["web", "eu", "web"]);
  });

  it("caps the list at twelve entries", () => {
    const value = Array.from({ length: 20 }, (_, index) => `t${index}`).join(",");
    expect(parseTags(value)).toHaveLength(12);
  });
});

describe("hostSubtitle", () => {
  it("omits the default port", () => {
    expect(hostSubtitle("root", "example.com", 22)).toBe("root@example.com");
  });

  it("keeps a custom port", () => {
    expect(hostSubtitle("", "example.com", 2222)).toBe("example.com:2222");
  });
});
