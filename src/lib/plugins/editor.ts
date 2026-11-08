/** Version 1 plugin protocol DTOs. Keep these independent of editor store state. */
export interface PluginEditorDocument {
  tabId: string;
  documentId: string;
  version: number;
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

export interface PluginEditorWriteResult {
  tabId: string;
  documentId: string;
  version: number;
  dirty: boolean;
}

/** Explicit projection prevents future internal fields from entering the protocol. */
export function pluginEditorDocument(
  document: PluginEditorDocument | null,
): PluginEditorDocument | null {
  if (!document) return null;
  return {
    tabId: document.tabId,
    documentId: document.documentId,
    version: document.version,
    path: document.path,
    name: document.name,
    content: document.content,
    dirty: document.dirty,
  };
}

export function pluginEditorWriteResult(
  document: PluginEditorWriteResult,
): PluginEditorWriteResult {
  return {
    tabId: document.tabId,
    documentId: document.documentId,
    version: document.version,
    dirty: document.dirty,
  };
}
