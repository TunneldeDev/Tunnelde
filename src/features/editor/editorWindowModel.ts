import type { WindowModelAppearance } from "@/app/panelReadModels";
import type { EditorPageModel } from "./editorPageServices";
import type { EditorSelectionSnapshot } from "@/store/editors";
export interface EditorWindowModel extends WindowModelAppearance {
  editor: Omit<EditorPageModel, "frozen" | "syncFailure">;
  tabId: string;
}
export interface EditorPatch {
  from: number;
  to: number;
  insert: string;
  inputType: string;
  before: EditorSelectionSnapshot | null;
  after: EditorSelectionSnapshot | null;
}
export type EditorWindowOperation =
  | "edit"
  | "save"
  | "encoding"
  | "reopen"
  | "retryOpen"
  | "reconnect"
  | "setup"
  | "format"
  | "plugin"
  | "undo"
  | "review"
  | "syntax"
  | "clipboard"
  | "recover"
  | "clearLocation";
export interface EditorWindowCommand {
  operation: EditorWindowOperation;
  data: Record<string, unknown>;
}
export interface EditorWindowAck {
  documentId: string;
  version: number;
  selection?: EditorSelectionSnapshot | null;
}
/** Small contiguous source-text patch. CRLF and UTF-16 offsets are preserved. */
export function editorPatch(
  before: string,
  after: string,
): Pick<EditorPatch, "from" | "to" | "insert"> {
  let from = 0,
    end = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  while (
    end < before.length - from &&
    end < after.length - from &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const splitsScalar = (text: string, offset: number) =>
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff;
  // JSON's native parser rejects isolated UTF-16 surrogates. Expand a shared
  // emoji prefix/suffix so each transmitted insertion remains scalar-valid.
  if (splitsScalar(before, from) || splitsScalar(after, from)) from--;
  if (
    end > 0 &&
    (splitsScalar(before, before.length - end) || splitsScalar(after, after.length - end))
  )
    end--;
  return { from, to: before.length - end, insert: after.slice(from, after.length - end) };
}
