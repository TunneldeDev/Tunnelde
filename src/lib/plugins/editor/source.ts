import { editorDocument } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import type { EditorBufferIdentity } from "@/lib/extensions/contracts/editor/data/identity";

/** A retained checkpoint alone must not make a closed/non-editor tab addressable. */
export function readyBuffer(tabId: string) {
  if (
    !useWorkspace
      .getState()
      .tabs.some((tab) => tab.id === tabId && tab.kind === "editor" && !tab.hidden)
  )
    return null;
  return editorDocument(tabId);
}

export function currentBuffer(identity: EditorBufferIdentity) {
  const document = readyBuffer(identity.tabId);
  if (
    !document ||
    document.documentId !== identity.documentId ||
    document.version !== identity.version
  )
    throw new Error("editor.documentChanged");
  return document;
}
