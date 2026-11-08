import { expect, it } from "vitest";
import { parseShortcutQuery, toggleShortcutFilter } from "@/lib/keyboard/query";
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
