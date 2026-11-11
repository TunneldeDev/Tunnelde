import type { EditorBufferIdentity } from "@/lib/extensions/contracts/editor/data/identity";

export const bytes = (text: string) => new TextEncoder().encode(text).length;

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("invalid:params");
  return value as Record<string, unknown>;
}

export function identifier(value: unknown, key: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0"))
    throw new Error(`invalid:${key}`);
  return value;
}

export function integer(
  value: unknown,
  key: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`invalid:${key}`);
  return value as number;
}

export function identity(params: Record<string, unknown>): EditorBufferIdentity {
  return {
    tabId: identifier(params.tabId, "tabId"),
    documentId: identifier(params.documentId, "documentId"),
    version: integer(params.version, "version"),
  };
}

export function boundary(text: string, offset: number): boolean {
  if (offset < 0 || offset > text.length) return false;
  const before = text.charCodeAt(offset - 1),
    after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
