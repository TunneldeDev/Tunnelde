import type { EditorSelectionSnapshot } from "@/store/editors";
import { rememberViewElementState, viewElementState } from "@/lib/session/viewState";
export { locationOffset } from "./editorText";

const key = (tabId: string) => `editor:${tabId}:selection`;

export function suspendLargeEditorSelection(tabId: string, selection: EditorSelectionSnapshot) {
  rememberViewElementState(key(tabId), { ...selection });
}

export function restoreLargeEditorSelection(tabId: string): EditorSelectionSnapshot | null {
  const selection = viewElementState<EditorSelectionSnapshot>(key(tabId));
  return selection ? { ...selection } : null;
}
