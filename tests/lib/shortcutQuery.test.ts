import { expect, it } from "vitest";
import {
  clearShortcutFilters,
  parseShortcutQuery,
  toggleShortcutFilter,
} from "@/lib/keyboard/query";
import { shortcutCommands, shortcutFilter } from "@/lib/keyboard/registry";

it("toggles discoverable filters without losing text, other filters or duplicate plugin selections", () => {
  let query = "Format @IS:CONFLICT & @plugins:Alpha,beta";
  query = toggleShortcutFilter(query, "is", "modified");
  expect(parseShortcutQuery(query)).toEqual({
    text: "Format",
    states: new Set(["conflict", "modified"]),
    source: null,
    plugins: ["Alpha", "beta"],
  });
  query = toggleShortcutFilter(query, "plugins", "ALPHA");
  expect(parseShortcutQuery(query).plugins).toEqual(["beta"]);
  query = toggleShortcutFilter(query, "is", "conflict");
  expect(parseShortcutQuery(query).states).toEqual(new Set(["modified"]));
  query = toggleShortcutFilter(query, "source", "built-in");
  expect(parseShortcutQuery(query).plugins).toEqual([]);
  query = toggleShortcutFilter(query, "plugins", "gamma");
  expect(parseShortcutQuery(query).source).toBeNull();
  expect(parseShortcutQuery(query).plugins).toEqual(["gamma"]);
});

it("keeps unknown syntax and embedded operator-like text searchable", () => {
  expect(parseShortcutQuery("mail@is:conflict @is:unknown @source:unknown").text).toBe(
    "mail@is:conflict @is:unknown @source:unknown",
  );
  expect(parseShortcutQuery("@plugins:Alpha,alpha,beta").plugins).toEqual(["alpha", "beta"]);
});

it("requires @ for each shortcut filter and treats bare fields as ordinary text", () => {
  expect(parseShortcutQuery("is:conflict source:plugin plugins:Alpha")).toEqual({
    text: "is:conflict source:plugin plugins:Alpha",
    states: new Set(),
    source: null,
    plugins: [],
  });
  expect(parseShortcutQuery("is:conflict @is:modified").states).toEqual(new Set(["modified"]));
});

it("never activates quoted, excluded or embedded filters while editing presets", () => {
  const literal = '"search @is:conflict" "@source:plugin" -@is:modified mail@plugins:Alpha';
  const parsed = parseShortcutQuery(literal);
  expect(parsed.states.size).toBe(0);
  expect(parsed.source).toBeNull();
  expect(parsed.plugins).toEqual([]);
  const changed = toggleShortcutFilter(literal, "is", "unassigned");
  expect(changed).toBe(`${literal} @is:unassigned`);
  expect(parseShortcutQuery(changed).states).toEqual(new Set(["unassigned"]));
  expect(clearShortcutFilters(changed)).toBe(literal);
});

it("preserves ampersands and quoted plugin names through filter edits", () => {
  expect(clearShortcutFilters('"A & B" @is:conflict & @plugins:One')).toBe('"A & B"');
  const query = toggleShortcutFilter("Find&Replace @is:modified", "plugins", "Plugin One");
  expect(parseShortcutQuery(query)).toEqual({
    text: "Find&Replace",
    states: new Set(["modified"]),
    source: null,
    plugins: ["Plugin One"],
  });
  expect(toggleShortcutFilter(query, "plugins", "plugin one")).toBe("Find&Replace @is:modified");
});

it("combines modified, disabled bindings and source filters with ordinary text", () => {
  const commands = shortcutCommands();
  const settings = commands.find((item) => item.id === "page.settings")!;
  const overrides = { "page.settings": [] };
  expect(
    shortcutFilter(
      settings,
      "settings @is:modified @is:unassigned @source:built-in",
      overrides,
      commands,
      "Settings",
    ),
  ).toBe(true);
  expect(shortcutFilter(settings, "@is:unassigned", {}, commands, "Settings")).toBe(false);
  expect(shortcutFilter(settings, "@source:plugin", overrides, commands, "Settings")).toBe(false);
  expect(shortcutFilter(settings, "@is:modified", {}, commands, "Settings")).toBe(false);
});
