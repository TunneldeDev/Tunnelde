const encoder = new TextEncoder();
export const PAGE_BYTES = 64 * 1024;
export const bytes = (value: string) => encoder.encode(value).length;

export function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error("plugin.fileBrowser.invalid");
  return value as Record<string, unknown>;
}
export function token(value: unknown): string {
  if (typeof value !== "string" || !value || bytes(value) > 128 || /[\p{Cc}\p{Cs}]/u.test(value))
    throw new Error("plugin.fileBrowser.invalid");
  return value;
}
export function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new Error("plugin.fileBrowser.invalid");
  return value as number;
}
export function path(value: unknown): string {
  if (typeof value !== "string" || !value || bytes(value) > 32768 || /[\0\p{Cs}]/u.test(value))
    throw new Error("plugin.fileBrowser.invalid");
  return value;
}

/** Keep entire Unicode scalars; error truncation is explicit in the DTO. */
export function errorText(value: string | null): { error: string | null; errorTruncated: boolean } {
  if (value === null) return { error: null, errorTruncated: false };
  if (bytes(value) <= 2048) return { error: value, errorTruncated: false };
  let text = "";
  let used = 0;
  for (const scalar of value) {
    const length = bytes(scalar);
    if (used + length > 2048) break;
    text += scalar;
    used += length;
  }
  return { error: text, errorTruncated: true };
}

/** Item and serialized-byte limits both matter for long names and escaped control characters. */
export function page<T>(
  rows: readonly T[],
  offset: number,
  limit: number,
): {
  items: readonly T[];
  nextOffset: number | null;
} {
  if (offset > rows.length || limit < 1) throw new Error("plugin.fileBrowser.invalid");
  const items: T[] = [];
  let used = 2048;
  for (const row of rows.slice(offset, offset + limit)) {
    const length = bytes(JSON.stringify(row)) + 1;
    if (used + length > PAGE_BYTES) {
      if (!items.length) throw new Error("plugin.api.responseTooLarge");
      break;
    }
    items.push(row);
    used += length;
  }
  const end = offset + items.length;
  return { items: Object.freeze(items), nextOffset: end < rows.length ? end : null };
}
