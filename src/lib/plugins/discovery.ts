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
      return term.startsWith("tag:") ? tags.includes(term.slice(4)) : text.includes(term);
    });
}
