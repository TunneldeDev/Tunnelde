import { replaceEditorDocument } from "@/store/editors";
import type { EditorBufferEditsResult } from "@/lib/extensions/contracts/editor/data/edits";
import { currentBuffer } from "./source";
import { boundary, bytes, identity, integer, object, wellFormed } from "./validation";

/** Validate against one original buffer before committing one undoable store mutation. */
export function applyBufferEdits(input: unknown): EditorBufferEditsResult {
  const params = object(input, ["tabId", "documentId", "version", "edits"]);
  const reference = identity(params);
  if (!Array.isArray(params.edits) || params.edits.length > 128) throw new Error("invalid:edits");
  const document = currentBuffer(reference),
    original = document.content;
  // The existing undo store retains at most 4MiB UTF-16 text per history.
  // Bounding the original too ensures a successful batch actually keeps its undo step.
  if (original.length > 2 * 1024 * 1024 || bytes(original) > 2 * 1024 * 1024)
    throw new Error("editor.documentTooLarge");
  let lastStart = -1,
    lastEnd = 0,
    replacementBytes = 0;
  const pieces: string[] = [];
  for (const value of params.edits) {
    const edit = object(value, ["start", "end", "text"]);
    const start = integer(edit.start, "start"),
      end = integer(edit.end, "end");
    if (
      start <= lastStart ||
      start < lastEnd ||
      end < start ||
      !boundary(original, start) ||
      !boundary(original, end)
    )
      throw new Error("invalid:range");
    if (typeof edit.text !== "string" || !wellFormed(edit.text)) throw new Error("invalid:text");
    replacementBytes += bytes(edit.text);
    if (replacementBytes > 65536) throw new Error("editor.editTooLarge");
    pieces.push(original.slice(lastEnd, start), edit.text);
    lastStart = start;
    lastEnd = end;
  }
  pieces.push(original.slice(lastEnd));
  const text = pieces.join("");
  if (!wellFormed(text)) throw new Error("editor.invalidUnicode");
  if (bytes(text) > 2 * 1024 * 1024) throw new Error("editor.documentTooLarge");
  if (text !== original && reference.version === Number.MAX_SAFE_INTEGER)
    throw new Error("editor.versionExhausted");
  const updated = replaceEditorDocument(reference, text);
  return {
    schemaVersion: 1,
    tabId: updated.tabId,
    documentId: updated.documentId,
    version: updated.version,
    dirty: updated.dirty,
    utf16Length: updated.content.length,
  };
}
