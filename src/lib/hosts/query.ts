import type { Host } from "@/lib/api/types";

export interface HostQuery {
  text: string[];
  tags: string[];
  favorite: boolean;
}

const unquote = (value: string) => value.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1");

/** Keep quoted tags together, including an unfinished quote while the user types. */
export function parseHostQuery(query: string): HostQuery {
  const tokens = query.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*"?)+/g) ?? [];
  const result: HostQuery = { text: [], tags: [], favorite: false };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (/^@tag$/i.test(token)) {
      const tag = unquote(tokens[++index] ?? "");
      if (tag) result.tags.push(tag.toLocaleLowerCase());
    } else if (/^tag:/i.test(token)) {
      const tag = unquote(token.slice(4));
      if (tag) result.tags.push(tag.toLocaleLowerCase());
    } else if (token.toLowerCase() === "is:favorite") result.favorite = true;
    else result.text.push(unquote(token).toLocaleLowerCase());
  }
  return result;
}

export function matchesHostQuery(host: Host, query: HostQuery): boolean {
  const tags = host.tags.map((tag) => tag.toLocaleLowerCase());
  const haystack = [host.name, host.host, host.username, ...host.tags]
    .join("\n")
    .toLocaleLowerCase();
  return (
    (!query.favorite || host.favorite) &&
    query.tags.every((tag) => tags.includes(tag)) &&
    query.text.every((word) => haystack.includes(word))
  );
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
