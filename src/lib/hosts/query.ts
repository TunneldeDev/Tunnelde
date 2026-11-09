import type { Host } from "@/lib/api/types";
import {
  matchesSearch,
  matchesSearchNumber,
  parseSearchQuery,
  searchText,
  type SearchQuery,
} from "@/lib/search/query";

export interface HostQuery extends SearchQuery {
  tags: string[];
  favorite: boolean;
}

const unquote = (value: string) => value.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1");

/** Keep quoted tags together, including an unfinished quote while the user types. */
export function parseHostQuery(query: string): HostQuery {
  const parsed = parseSearchQuery(query.replace(/(^|\s)@tag\s+/gi, "$1tag:"), [
    "tag",
    "is",
    "name",
    "host",
    "user",
    "port",
  ]);
  return {
    ...parsed,
    tags: parsed.filters
      .filter((filter) => filter.key === "tag" && !filter.exclude)
      .flatMap((filter) => filter.values),
    favorite: parsed.filters.some(
      (filter) => filter.key === "is" && !filter.exclude && filter.values.includes("favorite"),
    ),
  };
}

export function matchesHostQuery(host: Host, query: HostQuery): boolean {
  const tags = host.tags.map((tag) => tag.toLocaleLowerCase());
  const haystack = [host.name, host.host, host.username, ...host.tags]
    .join("\n")
    .toLocaleLowerCase();
  return matchesSearch(query, haystack, {
    tag: tags,
    is: host.favorite ? ["favorite"] : [],
    name: (value) => searchText(host.name).includes(value),
    host: (value) => searchText(host.host).includes(value),
    user: host.username,
    port: (value) => matchesSearchNumber(host.port, value),
  });
}

export function tagCompletion(query: string): { start: number; value: string } | null {
  const match = /(?:^|\s)(?:tag:|@tag\s*)("(?:[^"\\]|\\.)*"?|[^\s]*)$/i.exec(query);
  if (!match) return null;
  return { start: match.index + (/^\s/.test(match[0]) ? 1 : 0), value: unquote(match[1] ?? "") };
}

export function completeHostTag(query: string, tag: string): string {
  const completion = tagCompletion(query);
  const prefix = completion ? query.slice(0, completion.start) : query.trimEnd();
  const value = /[\s"\\]/.test(tag) ? JSON.stringify(tag) : tag;
  return `${prefix}${prefix && !/\s$/.test(prefix) ? " " : ""}tag:${value} `;
}
