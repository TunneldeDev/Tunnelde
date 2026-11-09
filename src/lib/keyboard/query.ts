import { rewriteSearchFilters, searchQueryText, type SearchFilter } from "@/lib/search/query";

export type ShortcutFilterKey = "is" | "source" | "plugins";
interface ShortcutQuery {
  text: string;
  states: Set<string>;
  source: string | null;
  plugins: string[];
}

function consumeShortcutFilters(query: string, consume: (filter: SearchFilter) => void): string {
  return rewriteSearchFilters(query, ["is", "source", "plugins"], (filter, raw) => {
    if (filter.exclude) return raw;
    const values = filter.values.map((value) => value.toLowerCase());
    if (
      (filter.key === "is" &&
        (values.length !== 1 || !["conflict", "modified", "unassigned"].includes(values[0]!))) ||
      (filter.key === "source" &&
        (values.length !== 1 || !["built-in", "plugin"].includes(values[0]!)))
    )
      return raw;
    consume(filter);
    return null;
  });
}

/** Remove only supported, explicit qualifiers; keep quoted search text quoted. */
export function clearShortcutFilters(query: string): string {
  return consumeShortcutFilters(query, () => {});
}

/** Typed queries and menu edits use the same mandatory-@, quote-aware tokenizer. */
export function parseShortcutQuery(query: string): ShortcutQuery {
  const states = new Set<string>();
  const plugins = new Map<string, string>();
  let source: string | null = null;
  const literal = consumeShortcutFilters(query, (filter) => {
    switch (filter.key) {
      case "is":
        states.add(filter.values[0]!.toLowerCase());
        break;
      case "source":
        source = filter.values[0]!.toLowerCase();
        break;
      case "plugins":
        for (const name of filter.values) plugins.set(name.toLowerCase(), name);
        break;
    }
  });
  const text = searchQueryText(literal, []);
  return { text, states, source, plugins: [...plugins.values()] };
}

export function toggleShortcutFilter(query: string, key: ShortcutFilterKey, value: string): string {
  const parsed = parseShortcutQuery(query);
  if (key === "is") {
    if (!parsed.states.delete(value)) parsed.states.add(value);
  } else if (key === "source") {
    parsed.source = parsed.source === value ? null : value;
    // A specific plugin selection belongs to the plugin source.
    if (parsed.source === "built-in") parsed.plugins = [];
  } else {
    const existing = parsed.plugins.findIndex((name) => name.toLowerCase() === value.toLowerCase());
    if (existing >= 0) parsed.plugins.splice(existing, 1);
    else parsed.plugins.push(value);
    if (parsed.source === "built-in") parsed.source = null;
  }
  return [
    clearShortcutFilters(query),
    ...[...parsed.states].map((state) => `@is:${state}`),
    parsed.source ? `@source:${parsed.source}` : "",
    parsed.plugins.length
      ? `@plugins:${parsed.plugins.map((name) => (/[\s,"\\]/.test(name) ? JSON.stringify(name) : name)).join(",")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
