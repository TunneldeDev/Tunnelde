import { editorDocument, replaceEditorDocument, EDITOR_DOCUMENT_MAX_BYTES } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { pluginEditorDocument, pluginEditorWriteResult } from "@/lib/plugins/editor";
import { bytes, identifier, integer } from "@/lib/plugins/editor/validation";
import { observeBuffer } from "@/lib/plugins/editor/observation";
import { readBufferRange } from "@/lib/plugins/editor/range";
import { applyBufferEdits } from "@/lib/plugins/editor/edits";

/** Caller owns live authorization. Stable methods retain their permissive v1 input shape. */
export async function runEditorRequest(
  method: string,
  params: Record<string, unknown>,
  authorize: () => Promise<void>,
): Promise<unknown> {
  switch (method) {
    case "editor.active": {
      const activeId = useWorkspace.getState().activeId;
      const document = activeId ? editorDocument(activeId) : null;
      if (document && bytes(document.content) > EDITOR_DOCUMENT_MAX_BYTES)
        throw new Error("editor.documentTooLarge");
      return pluginEditorDocument(document);
    }
    case "editor.replace": {
      const tabId = identifier(params.tabId, "tabId"),
        documentId = identifier(params.documentId, "documentId");
      const version = integer(params.version, "version");
      if (typeof params.text !== "string" || bytes(params.text) > EDITOR_DOCUMENT_MAX_BYTES)
        throw new Error("invalid:text");
      return pluginEditorWriteResult(
        replaceEditorDocument({ tabId, documentId, version }, params.text),
      );
    }
    case "editor.observe": {
      const result = await observeBuffer(params);
      await authorize();
      return result;
    }
    case "editor.readRange":
      return readBufferRange(params);
    case "editor.applyEdits":
      return applyBufferEdits(params);
    default:
      throw new Error("plugin.api.unknownMethod");
  }
}
