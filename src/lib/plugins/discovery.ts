/** The registry is bounded metadata; only this many matching rows mount at once. */
export const PLUGIN_PAGE_SIZE = 24;

export interface SearchablePlugin {
  id: string;
  name: string;
  description?: string | null;
  author?: string | null;
  tags?: string[];
}

export function pluginTags(plugin: SearchablePlugin): string[] {
  return [...new Set((plugin.tags ?? []).map((tag) => tag.toLocaleLowerCase()))];
}

export function matchesPlugin(plugin: SearchablePlugin, query: string, tag: string): boolean {
  const tags = pluginTags(plugin);
  if (tag && !tags.includes(tag.toLocaleLowerCase())) return false;
  const text =
    `${plugin.name} ${plugin.id} ${plugin.description ?? ""} ${plugin.author ?? ""} ${tags.join(" ")}`.toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => {
      if (!term.startsWith("tag:")) return text.includes(term);
      const requested = term.slice(4).split(",").filter(Boolean);
      return requested.length > 0 && requested.some((value) => tags.includes(value));
    });
}

/** Keep tag filters visible and editable in the search box. */
export function togglePluginTag(query: string, tag: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const filters = tokens.filter((token) => token.toLocaleLowerCase().startsWith("tag:"));
  const tags = [...new Set(filters.flatMap((token) => token.slice(4).split(",")).filter(Boolean))];
  const index = tags.findIndex((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase());
  if (index < 0) tags.push(tag);
  else tags.splice(index, 1);
  return [
    ...(tags.length ? [`tag:${tags.join(",")}`] : []),
    ...tokens.filter((token) => !token.toLocaleLowerCase().startsWith("tag:")),
  ].join(" ");
}
