import { describe, expect, it } from "vitest";
import {
  clearSearchFilters,
  matchesSearch,
  matchesSearchDate,
  matchesSearchNumber,
  parseSearchQuery,
  searchQueryText,
  toggleSearchFilter,
} from "@/lib/search/query";

describe("shared search qualifiers", () => {
  it("intersects repeated fields and words, with comma alternatives and exclusions", () => {
    const query = parseSearchQuery('上海 tag:prod,dev tag:"生产 环境" -is:hidden & name:api', [
      "tag",
      "is",
      "name",
    ]);
    const fields = { tag: ["prod", "生产 环境"], is: [], name: "api" };
    expect(matchesSearch(query, "上海 api", fields)).toBe(true);
    expect(matchesSearch(query, "上海 api", { ...fields, tag: ["prod"] })).toBe(false);
    expect(matchesSearch(query, "上海 api", { ...fields, is: ["hidden"] })).toBe(false);
    expect(matchesSearch(query, "api", fields)).toBe(false);
  });

  it("keeps commas, quotes, backslashes and unfinished quoted values together", () => {
    const value = 'a "quoted" \\ tag,one';
    expect(parseSearchQuery(`tag:${JSON.stringify(value)}`, ["tag"]).filters[0]?.values).toEqual([
      value,
    ]);
    expect(parseSearchQuery('tag:"生产 环境', ["tag"]).filters[0]?.values).toEqual(["生产 环境"]);
    expect(parseSearchQuery('tag:a,"b,c",d', ["tag"]).filters[0]?.values).toEqual([
      "a",
      "b,c",
      "d",
    ]);
    expect(parseSearchQuery("C:\\work\\nested\\", []).text).toEqual(["c:\\work\\nested\\"]);
  });

  it("retains unknown, empty and quoted qualifiers as literal words", () => {
    const query = parseSearchQuery('repo:owner/app tag: tag:"" "tag:prod"', ["tag"]);
    expect(query.filters).toEqual([]);
    expect(query.text).toEqual(["repo:owner/app", "tag:", "tag:", "tag:prod"]);
    expect(clearSearchFilters('"tag:prod" tag:dev repo:a', ["tag"])).toBe('"tag:prod" repo:a');
  });

  it("normalizes Unicode and aliases and matches false/zero without matching missing fields", () => {
    const query = parseSearchQuery("@NAME:ＦＯＯ port:0 is:false", ["name", "port", "is"]);
    expect(matchesSearch(query, "", { name: "foo", port: 0, is: false })).toBe(true);
    expect(matchesSearch(parseSearchQuery("name:null", ["name"]), "", {})).toBe(false);
  });

  it("does not collapse repeated AND groups while editing menu alternatives", () => {
    expect(toggleSearchFilter('hello tag:Prod tag:"生产 环境" -tag:archive', "tag", "dev")).toBe(
      'hello tag:Prod tag:"生产 环境",dev -tag:archive',
    );
    expect(toggleSearchFilter('tag:Prod tag:"生产 环境",dev -tag:archive', "tag", "DEV")).toBe(
      'tag:Prod tag:"生产 环境" -tag:archive',
    );
    expect(toggleSearchFilter('tag:a,b tag:a -tag:a "tag:a"', "tag", "a")).toBe(
      'tag:b -tag:a "tag:a"',
    );
  });

  it("replaces an exclusive selection, preserves other fields, and avoids duplicate prefixes", () => {
    expect(toggleSearchFilter("file type:folder type:file -type:link", "type", "file", true)).toBe(
      "file -type:link",
    );
    expect(toggleSearchFilter("file type:folder tag:a", "type", "file", true)).toBe(
      "file tag:a type:file",
    );
    expect(toggleSearchFilter("file ext:", "ext", "")).toBe("file ext:");
    const next = toggleSearchFilter('"tag:literal"', "tag", 'a,b "c"');
    expect(parseSearchQuery(next, ["tag"]).filters[0]?.values).toEqual(['a,b "c"']);
  });

  it("preserves literal content case and consecutive whitespace when stripping qualifiers", () => {
    expect(toggleSearchFilter("Foo  Bar", "ext", "ts")).toBe("Foo  Bar ext:ts");
    expect(clearSearchFilters("Foo  Bar ext:ts", ["ext"])).toBe("Foo  Bar");
    expect(searchQueryText("Foo  Bar ext:ts", ["ext"])).toBe("Foo  Bar");
    expect(searchQueryText('ext:ts "Foo  Bar"', ["ext"])).toBe("Foo  Bar");
    expect(searchQueryText('"ext:ts" repo:a', ["ext"])).toBe("ext:ts repo:a");
  });

  it("compares finite numbers and decimal/binary units without accepting expressions", () => {
    expect(matchesSearchNumber(1024, ">=1KiB")).toBe(true);
    expect(matchesSearchNumber(1000, "1KB")).toBe(true);
    expect(matchesSearchNumber(1000, ">1KiB")).toBe(false);
    for (const term of ["1e3", "1+1", "1XB", "-1", "9".repeat(400)])
      expect(matchesSearchNumber(1000, term)).toBe(false);
    expect(matchesSearchNumber(null, "0")).toBe(false);
  });

  it("uses local calendar dates and rejects invalid calendar or out-of-range times", () => {
    const date = new Date(2026, 10, 9, 0, 15).getTime();
    expect(matchesSearchDate(date, "2026-11-09")).toBe(true);
    expect(matchesSearchDate(date, ">2026-11-08")).toBe(true);
    expect(matchesSearchDate(date, "<2026-11-10")).toBe(true);
    for (const term of ["2026-02-30", "2026-13-01", "today"])
      expect(matchesSearchDate(date, term)).toBe(false);
    expect(matchesSearchDate(1e30, "2026-11-09")).toBe(false);
    expect(matchesSearchDate(null, "2026-11-09")).toBe(false);
  });
});
