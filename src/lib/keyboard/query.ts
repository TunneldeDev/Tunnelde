export type ShortcutFilterKey = "is" | "source" | "plugins";
interface ShortcutQuery {
  text: string;
  states: Set<string>;
  source: string | null;
  plugins: string[];
}

/** One parser for typed queries, menu state, and non-destructive filter edits. */
export function parseShortcutQuery(query: string): ShortcutQuery {
  const states = new Set<string>();
  const plugins = new Map<string, string>();
  let source: string | null = null;
  const text = query
    .replace(/(^|[\s&])@(is|source|plugins):([^\s&]+)/gi, (token, prefix, key, value) => {
      const normalized = value.toLowerCase();
      switch (key.toLowerCase()) {
        case "is":
          if (!["conflict", "modified", "unassigned"].includes(normalized)) return token;
          states.add(normalized);
          break;
        case "source":
          if (!["built-in", "plugin"].includes(normalized)) return token;
          source = normalized;
          break;
        case "plugins":
          for (const name of value.split(",").filter(Boolean))
            plugins.set(name.toLowerCase(), name);
          break;
      }
      return prefix;
    })
    .replace(/&/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    parsed.text,
    ...[...parsed.states].map((state) => `@is:${state}`),
    parsed.source ? `@source:${parsed.source}` : "",
    parsed.plugins.length ? `@plugins:${parsed.plugins.join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
