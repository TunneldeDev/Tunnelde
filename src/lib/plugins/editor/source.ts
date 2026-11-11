import { editorDocument } from "@/store/editors";
import type { EditorBufferIdentity } from "@/lib/extensions/contracts/editor/data/identity";

export function currentBuffer(identity: EditorBufferIdentity) {
  const document = editorDocument(identity.tabId);
  if (
    !document ||
    document.documentId !== identity.documentId ||
    document.version !== identity.version
  )
    throw new Error("editor.documentChanged");
  return document;
}
