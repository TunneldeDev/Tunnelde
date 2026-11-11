import type { EditorEntry } from "@/store/editors";
import type { SearchQuery } from "@/lib/search/query";
import { matchesSearch } from "@/lib/search/query";
import { inSearchRoot, searchPathKey } from "@/lib/files/searchPaths";
import { fileSearchFields, type SearchResult } from "./model";
import type { QuickAccessMode } from "./query";
export function collectQuickAccessMatches({
  mode,
  result,
  searchKey,
  entries,
  needle,
  sessionId,
  path,
  parsedQuery,
}: {
  mode: QuickAccessMode;
  result: SearchResult | null;
  searchKey: string;
  entries: Record<string, EditorEntry>;
  needle: string;
  sessionId: string | null;
  path: string | undefined;
  parsedQuery: SearchQuery;
}) {
  const visible = result?.key === searchKey ? result.matches : [];
  const drafts =
    mode === "content" && needle.length >= 2
      ? Object.values(entries).filter(
          (entry) =>
            entry.sessionId === sessionId &&
            !!path &&
            inSearchRoot(entry.path, path, sessionId) &&
            !entry.loading &&
            !entry.error &&
            matchesSearch(
              { text: [], filters: parsedQuery.filters },
              "",
              fileSearchFields(entry.path),
            ),
        )
      : [];
  const matches = [
    ...visible.filter(
      (match) =>
        !drafts.some(
          (entry) => searchPathKey(entry.path, sessionId) === searchPathKey(match.path, sessionId),
        ),
    ),
  ];
  const loweredNeedle = needle.toLocaleLowerCase();
  for (const entry of drafts) {
    for (const [line, text] of entry.content.split("\n").entries()) {
      const offset = text.toLocaleLowerCase().indexOf(loweredNeedle);
      if (offset >= 0) {
        if (matches.length >= 100) return { matches, limited: true };
        matches.push({
          path: entry.path,
          line: line + 1,
          column: Array.from(text.slice(0, offset)).length + 1,
          preview: text.slice(Math.max(0, offset - 60), offset + 180),
        });
      }
    }
  }

  return { matches, limited: result?.key === searchKey && result.limited };
}
