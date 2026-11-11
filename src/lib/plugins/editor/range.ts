import type { EditorBufferRange } from "@/lib/extensions/contracts/editor/data/range";
import { currentBuffer } from "./source";
import { boundary, identity, integer, object, wellFormed } from "./validation";

export function readBufferRange(input: unknown): EditorBufferRange {
  const params = object(input, ["tabId", "documentId", "version", "offset", "limit"]);
  const reference = identity(params);
  const offset = integer(params.offset, "offset");
  const limit = Object.hasOwn(params, "limit") ? integer(params.limit, "limit", 2, 16384) : 16384;
  const document = currentBuffer(reference);
  if (!boundary(document.content, offset)) throw new Error("invalid:offset");
  let end = Math.min(document.content.length, offset + limit);
  if (!boundary(document.content, end)) end--;
  const text = document.content.slice(offset, end);
  if (!wellFormed(text)) throw new Error("editor.invalidUnicode");
  return {
    schemaVersion: 1,
    ...reference,
    offset,
    totalLength: document.content.length,
    text,
    nextOffset: end < document.content.length ? end : null,
  };
}
