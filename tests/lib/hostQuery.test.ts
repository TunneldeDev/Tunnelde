import { describe, expect, it } from "vitest";
import { completeHostTag, matchesHostQuery, parseHostQuery } from "@/lib/hosts/query";
import type { Host } from "@/lib/api/types";

const host = {
  name: "上海 edge",
  host: "192.168.5.206",
  username: "deploy",
  tags: ["PublicNet", "生产 环境"],
  favorite: true,
} as Host;

describe("host search", () => {
  it("does not interpret bare fields as filters even when metadata matches", () => {
    for (const query of ["tag:PublicNet", "is:favorite", "host:192.168.5.206", "user:deploy"])
      expect(matchesHostQuery(host, parseHostQuery(query))).toBe(false);
    expect(
      matchesHostQuery({ ...host, name: "tag:PublicNet" }, parseHostQuery("tag:PublicNet")),
    ).toBe(true);
  });
  it("accepts the requested @tag syntax and GitHub-style exact tag qualifiers", () => {
    for (const query of [
      "@tag:PublicNet",
      "@tag:publicnet",
      '@tag:"生产 环境"',
      'edge @tag:PublicNet @tag:"生产 环境" @is:favorite',
    ])
      expect(matchesHostQuery(host, parseHostQuery(query))).toBe(true);
    expect(matchesHostQuery(host, parseHostQuery("@tag:Public"))).toBe(false);
    expect(matchesHostQuery(host, parseHostQuery("@tag:missing"))).toBe(false);
  });

  it("combines text terms with tags and favorites without discarding Unicode", () => {
    expect(matchesHostQuery(host, parseHostQuery("上海 deploy 206"))).toBe(true);
    expect(matchesHostQuery(host, parseHostQuery("上海 nonexistent"))).toBe(false);
    expect(matchesHostQuery({ ...host, favorite: false }, parseHostQuery("@is:favorite"))).toBe(
      false,
    );
  });

  it("completes partial qualifiers and quotes tags without losing other filters", () => {
    expect(completeHostTag("edge @tag:Pub", "PublicNet")).toBe("edge @tag:PublicNet ");
    expect(completeHostTag("@tag:Pub", "PublicNet")).toBe("@tag:PublicNet ");
    expect(completeHostTag("edge", "生产 环境")).toBe('edge @tag:"生产 环境" ');
    expect(completeHostTag('@tag:"生产', "生产 环境")).toBe('@tag:"生产 环境" ');
    const tag = 'a "quoted" \\ tag';
    expect(parseHostQuery(completeHostTag("", tag)).tags).toEqual([tag]);
  });
});
