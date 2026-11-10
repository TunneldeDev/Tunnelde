import { parseSearchQuery, searchQueryText } from "@/lib/search/query";
export type QuickAccessMode = "commands" | "content" | "hosts" | "files";
export function quickAccessQuery(query: string) {
  const mode: QuickAccessMode = query.startsWith(">")
    ? "commands"
    : query.startsWith("%")
      ? "content"
      : query.startsWith("@") && !/^@[a-z][\w-]*:/i.test(query)
        ? "hosts"
        : "files";
  const rawNeedle = (mode === "files" ? query : query.slice(1)).trim();
  const filterKeys =
    mode === "commands"
      ? ["id", "category", "plugin"]
      : mode === "hosts"
        ? ["name", "host", "user", "tag", "is", "port"]
        : ["name", "path", "ext"];
  const parsedQuery = parseSearchQuery(rawNeedle, filterKeys);
  const needle = searchQueryText(rawNeedle, filterKeys);
  const selection =
    mode === "content"
      ? parsedQuery.filters.length
        ? { text: [], filters: parsedQuery.filters }
        : undefined
      : mode === "files" && (parsedQuery.filters.length || parsedQuery.text.length > 1)
        ? parsedQuery
        : undefined;
  return {
    mode,
    rawNeedle,
    filterKeys,
    parsedQuery,
    needle,
    selection,
    canSearch: Array.from(needle).length >= 2 || (mode === "files" && !!selection),
  };
}
