import {
  matchesSearch,
  parseSearchQuery,
  searchText,
  toggleSearchFilter,
  type SearchQuery,
} from "@/lib/search/query";
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
  return [...new Set((plugin.tags ?? []).map(searchText))];
}

export function matchesPlugin(
  plugin: SearchablePlugin,
  query: string | SearchQuery,
  tag: string,
): boolean {
  const tags = pluginTags(plugin);
  if (tag && !tags.includes(tag.toLocaleLowerCase())) return false;
  const text =
    `${plugin.name} ${plugin.id} ${plugin.description ?? ""} ${plugin.author ?? ""} ${tags.join(" ")}`.toLocaleLowerCase();
  return matchesSearch(
    typeof query === "string" ? parseSearchQuery(query, ["tag", "name", "id", "author"]) : query,
    text,
    {
      tag: tags,
      id: plugin.id,
      author: plugin.author,
      name: (value) => searchText(plugin.name).includes(value),
    },
  );
}

/** Keep tag filters visible and editable in the search box. */
export function togglePluginTag(query: string, tag: string): string {
  return toggleSearchFilter(query, "tag", tag);
}
