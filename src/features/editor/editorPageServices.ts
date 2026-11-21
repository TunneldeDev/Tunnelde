import type { ComponentType } from "react";
import type { EditorEntry, EditorDocument, EditorSelectionSnapshot } from "@/store/editors";
import type { SshSession, TextEncoding } from "@/lib/api/types";
import type { ConfirmOptions } from "@/store/dialogs";
import type { CodeEditorSyntax } from "./syntax/useCodeEditorSyntax";
import type { SyntaxDocumentSnapshot } from "./syntax/useEditorSyntax";
import type { shortcutCommands } from "@/lib/keyboard/registry";
import type { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import type { useEditorLocation } from "@/store/editorLocation";
export interface EditorPageModel {
  entry: EditorEntry | undefined;
  candidate: SshSession | undefined;
  preferences: { wordWrap: boolean; tabSize: number; spellCheck: boolean };
  formatting: boolean;
  hasFormatter: boolean;
  commands: ReturnType<typeof shortcutCommands>;
  location: ReturnType<typeof useEditorLocation.getState>["target"];
  frozen?: boolean;
  syncFailure?: string;
}
/** Required owner boundary. The renderer never bootstraps a file resource or
 * consults writable singleton stores in a satellite document. */
export interface EditorPageServices {
  useModel(tabId: string): EditorPageModel;
  useSyntax(
    document: SyntaxDocumentSnapshot | null,
    enabled: boolean,
    composing: boolean,
  ): CodeEditorSyntax;
  document(tabId: string): EditorDocument | null;
  change(tabId: string, content: string, selection: EditorSelectionSnapshot | null): void;
  changeSaveEncoding(tabId: string, encoding: TextEncoding): boolean;
  save(tabId: string): Promise<boolean>;
  reconnect(
    tabId: string,
    sessionId: string,
    accept: boolean,
    target: { hostId: string; address: string },
  ): Promise<"ready" | "conflict" | "failed">;
  reopen(tabId: string, encoding: TextEncoding): Promise<boolean>;
  retryOpen(tabId: string): Promise<void>;
  setup(sessionId: string, path: string): Promise<boolean>;
  format(tabId: string): void;
  openPluginAction(
    action: NonNullable<ReturnType<typeof shortcutCommands>[number]["plugin"]>,
    document: EditorDocument | null,
  ): Promise<unknown>;
  confirm(options: ConfirmOptions): void;
  beforeInput(tabId: string, inputType: string, selection: EditorSelectionSnapshot | null): void;
  beginComposition(tabId: string, selection: EditorSelectionSnapshot | null): void;
  endComposition(tabId: string, selection: EditorSelectionSnapshot | null): void;
  rememberSelection(tabId: string, selection: EditorSelectionSnapshot | null): void;
  consumeSelection(
    tabId: string,
    documentId: string,
    version: number,
    content: string,
  ): EditorSelectionSnapshot | null;
  peekSelection(
    tabId: string,
    documentId: string,
    version: number,
    content: string,
  ): EditorSelectionSnapshot | null;
  restoreSelection(tabId: string): EditorSelectionSnapshot | null;
  suspendSelection(tabId: string, selection: EditorSelectionSnapshot): void;
  undo(tabId: string, redo?: boolean): boolean;
  clearLocation(): void;
  rendered?(ready: boolean): void;
  interaction?(blocked: boolean): void;
  attachView?(read: () => EditorSelectionSnapshot | null, focused?: () => boolean): () => void;
  resumeFocus?(focus: () => void): void;
  bindShortcuts: typeof bindShortcutProvider;
  shortcutCandidates: typeof scopedShortcutCandidates;
  ConflictDialog: ComponentType<{ tabId: string; onClose: () => void }>;
}
