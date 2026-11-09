export interface SearchFilter {
  key: string;
  values: string[];
  exclude: boolean;
}

export interface SearchQuery {
  text: string[];
  filters: SearchFilter[];
}

export type SearchValue = string | number | boolean | null | undefined;
export type SearchFields = Record<
  string,
  SearchValue | readonly SearchValue[] | ((value: string) => boolean)
>;

/** Split outside quotes only. Keep raw tokens so menu edits never reinterpret literals. */
function tokens(query: string, comma = false): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    if (char === "\\" && quoted && ["\\", '"'].includes(query[i + 1] ?? "")) i++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && (comma ? char === "," : /\s/.test(char!))) {
      if (i > start) result.push(query.slice(start, i));
      start = i + 1;
    }
  }
  if (start < query.length) result.push(query.slice(start));
  return result;
}

function decode(value: string): string {
  let result = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '"') quoted = !quoted;
    else if (char === "\\" && quoted && ["\\", '"'].includes(value[i + 1] ?? ""))
      result += value[++i];
    else result += char;
  }
  return result;
}

export const searchText = (value: SearchValue): string =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase();
const normalizedKey = (key: string) => key.replace(/^@/, "").toLowerCase();

function qualifier(token: string, keys: ReadonlySet<string>) {
  const match = /^(-?)@?([a-z][\w-]*):(.+)$/i.exec(token);
  if (!match || !keys.has(match[2]!.toLowerCase())) return null;
  const values = tokens(match[3]!, true).map(decode).filter(Boolean);
  return values.length ? { key: match[2]!.toLowerCase(), values, exclude: !!match[1] } : null;
}

function rewriteTokens(
  query: string,
  rewrite: (token: string, index: number) => string | null,
): string {
  let offset = 0;
  let result = "";
  tokens(query).forEach((token, index) => {
    const start = query.indexOf(token, offset);
    const next = rewrite(token, index);
    if (next !== null) result += query.slice(offset, start) + next;
    offset = start + token.length;
  });
  return result.trim();
}

/** Unknown and unfinished qualifiers remain literal. Repeated fields intersect; commas mean OR. */
export function parseSearchQuery(query: string, keys: readonly string[]): SearchQuery {
  const allowed = new Set(keys.map(normalizedKey));
  const result: SearchQuery = { text: [], filters: [] };
  for (const token of tokens(query)) {
    if (token === "&") continue;
    const filter = qualifier(token, allowed);
    if (filter) result.filters.push({ ...filter, values: filter.values.map(searchText) });
    else result.text.push(searchText(decode(token)));
  }
  return result;
}

/** Remove only recognized qualifiers, preserving quoted literals. */
export function clearSearchFilters(query: string, keys: readonly string[]): string {
  const allowed = new Set(keys.map(normalizedKey));
  return rewriteTokens(query, (token) => (qualifier(token, allowed) ? null : token));
}

/** Literal backend searches keep case and repeated whitespace; qualifiers are UI metadata. */
export function searchQueryText(query: string, keys: readonly string[]): string {
  const allowed = new Set(keys.map(normalizedKey));
  let offset = 0;
  let result = "";
  for (const token of tokens(query)) {
    const start = query.indexOf(token, offset);
    const gap = query.slice(offset, start);
    if (!qualifier(token, allowed) && token !== "&") result += gap + decode(token);
    offset = start + token.length;
  }
  return result.trim();
}

export function matchesSearch(query: SearchQuery, text: string, fields: SearchFields): boolean {
  const haystack = searchText(text);
  return (
    query.text.every((word) => haystack.includes(word)) &&
    query.filters.every((filter) => {
      const field = fields[filter.key];
      const matched = filter.values.some((value) =>
        typeof field === "function"
          ? field(value)
          : (Array.isArray(field) ? field : [field]).some(
              (item) => item != null && searchText(item) === value,
            ),
      );
      return filter.exclude ? !matched : matched;
    })
  );
}

const encode = (value: string) => (/[\s,"\\]/.test(value) ? JSON.stringify(value) : value);

/** Preserve repeated AND groups, exclusions and literal tokens when toggling an OR preset. */
export function toggleSearchFilter(
  query: string,
  key: string,
  value: string,
  exclusive = false,
): string {
  const allowed = new Set([normalizedKey(key)]);
  const raw = tokens(query);
  if (!value)
    return raw.some((token) => token === key + ":")
      ? query
      : query.trimEnd() + (query.trim() ? " " : "") + key + ":";
  const current = raw.map((token) => qualifier(token, allowed));
  const needle = searchText(value);
  const selected = current.some(
    (filter) =>
      filter && !filter.exclude && filter.values.some((item) => searchText(item) === needle),
  );
  let last = -1;
  current.forEach((filter, index) => {
    if (filter && !filter.exclude) last = index;
  });
  let next = rewriteTokens(query, (token, index) => {
    const filter = current[index];
    if (!filter || filter.exclude) return token;
    if (exclusive) return null;
    const values = selected
      ? filter.values.filter((item) => searchText(item) !== needle)
      : [...filter.values, ...(index === last ? [value] : [])];
    return values.length
      ? token.slice(0, token.indexOf(":")) + ":" + values.map(encode).join(",")
      : null;
  });
  if ((exclusive && !selected) || (last < 0 && !selected))
    next += (next ? " " : "") + key + ":" + encode(value);
  return next;
}

/** Comparisons and byte units, without evaluating expressions or accepting infinities. */
export function matchesSearchNumber(value: number | null | undefined, term: string): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(b|kb|mb|gb|tb|kib|mib|gib|tib)?$/i.exec(term);
  if (!match) return false;
  const unit = (match[3] ?? "").toLowerCase();
  const power = Math.max(0, ["", "k", "m", "g", "t"].indexOf(unit[0] ?? ""));
  const expected = Number(match[2]) * (unit.includes("i") ? 1024 : 1000) ** power;
  if (!Number.isFinite(expected)) return false;
  switch (match[1]) {
    case ">":
      return value > expected;
    case ">=":
      return value >= expected;
    case "<":
      return value < expected;
    case "<=":
      return value <= expected;
    default:
      return value === expected;
  }
}

/** Calendar dates follow the local day used by file/history presentation. Numeric times are milliseconds. */
export function matchesSearchDate(
  value: string | number | null | undefined,
  term: string,
): boolean {
  if (value == null) return false;
  const match = /^(>=|<=|>|<|=)?(\d{4}-\d{2}-\d{2})$/.exec(term);
  if (!match) return false;
  const date = new Date(value);
  const wanted = new Date(match[2] + "T12:00:00");
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(wanted.getTime())) return false;
  const dayOf = (item: Date) =>
    [
      String(item.getFullYear()).padStart(4, "0"),
      String(item.getMonth() + 1).padStart(2, "0"),
      String(item.getDate()).padStart(2, "0"),
    ].join("-");
  if (dayOf(wanted) !== match[2]) return false;
  const day = dayOf(date);
  switch (match[1]) {
    case ">":
      return day > match[2]!;
    case ">=":
      return day >= match[2]!;
    case "<":
      return day < match[2]!;
    case "<=":
      return day <= match[2]!;
    default:
      return day === match[2];
  }
}
