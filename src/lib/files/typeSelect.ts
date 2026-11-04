import type { FileEntry } from "@/lib/api/types";

export interface TypeSelectState {
  text: string;
  at: number;
  scope: string;
}
export const TYPE_SELECT_TIMEOUT = 1200;

export function typeSelect(
  entries: readonly FileEntry[],
  text: string,
  cursor: string | null,
  previous: TypeSelectState | undefined,
  scope: string,
  at: number,
  locale: string,
): { state: TypeSelectState; path: string | null } {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase(locale);
  const input = normalize(text);
  const continued = previous?.scope === scope && at - previous.at < TYPE_SELECT_TIMEOUT;
  const query = (continued ? previous.text : "") + input;
  let match = entries.find((entry) => normalize(entry.name).startsWith(query));
  // Prefer the full prefix ("yy") before treating repeated letters as cycling.
  if (!match && Array.from(query).every((char) => char === input) && input.length === 1) {
    const start = Math.max(
      -1,
      entries.findIndex((entry) => entry.path === cursor),
    );
    for (let offset = 1; offset <= entries.length; offset++) {
      const entry = entries[(start + offset) % entries.length]!;
      if (normalize(entry.name).startsWith(input)) {
        match = entry;
        break;
      }
    }
  }
  return { state: { text: query, at, scope }, path: match?.path ?? null };
}
