import {
  useEditors,
  editorDocument,
  beginEditorInput,
  beginEditorComposition,
  endEditorComposition,
  rememberEditorSelection,
  consumeEditorSelectionRestore,
  peekEditorSelectionRestore,
  undoEditorEdit,
} from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import { useEditorLocation } from "@/store/editorLocation";
import {
  useFormatting,
  documentFormatters,
  formatEditorDocument,
  editorCommandMatches,
} from "@/lib/plugins/formatting";
import { shortcutCommands } from "@/lib/keyboard/registry";
import { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import { openPluginAction } from "@/lib/plugins/actions";
import { api } from "@/lib/api/ipc";
import { useCodeEditorSyntax } from "./syntax/useCodeEditorSyntax";
import { restoreLargeEditorSelection, suspendLargeEditorSelection } from "./largeEditorState";
import { EditorConflictDialog } from "./EditorConflictDialog";
import type { EditorPageServices } from "./editorPageServices";
export function editorShortcutCommands(
  path: string,
  plugins: ReturnType<typeof usePlugins.getState>["items"],
) {
  return shortcutCommands(plugins).filter((command) => {
    if (command.scope !== "editor") return false;
    if (!command.plugin?.command) return true;
    const item = plugins
      .find((p) => p.id === command.plugin!.id)
      ?.commands.find((c) => c.id === command.plugin!.command);
    return !!item?.editor && editorCommandMatches(path, item.editor.extensions);
  });
}
export const mainEditorPageServices: EditorPageServices = {
  useModel(tabId) {
    const entry = useEditors((s) => s.entries[tabId]);
    const tabHostId = useWorkspace((s) => s.tabs.find((t) => t.id === tabId)?.hostId);
    const hostId = tabHostId ?? entry?.recoveryTarget?.hostId;
    const candidate = useSsh((s) =>
      s.sessions.find(
        (session) =>
          session.hostId === hostId &&
          session.purpose !== "forwarding" &&
          (!entry?.recoveryTarget || session.address === entry.recoveryTarget.address),
      ),
    );
    const settings = useSettings((s) => s.settings),
      plugins = usePlugins((s) => s.items);
    const formatting = useFormatting((s) => s.busy.includes(tabId));
    const location = useEditorLocation((s) => s.target);
    return {
      entry,
      candidate,
      preferences: {
        wordWrap: settings.editorWordWrap,
        tabSize: settings.editorTabSize,
        spellCheck: settings.editorSpellCheck,
      },
      formatting,
      hasFormatter: !!entry && documentFormatters(entry.path, plugins).length > 0,
      commands: editorShortcutCommands(entry?.path ?? "", plugins),
      location,
    };
  },
  useSyntax: useCodeEditorSyntax,
  document: editorDocument,
  change: (...args) => useEditors.getState().change(...args),
  changeSaveEncoding: (...args) => useEditors.getState().changeSaveEncoding(...args),
  save: (id) => useEditors.getState().save(id),
  reconnect: (...args) => useEditors.getState().reconnect(...args),
  reopen: (...args) => useEditors.getState().reopen(...args),
  retryOpen: (id) => useEditors.getState().retryOpen(id),
  setup: (session, path) => api.sftpSetupNativeSave(session, path),
  format: (id) => {
    void formatEditorDocument(id);
  },
  openPluginAction,
  confirm: (options) => useDialogs.getState().confirm(options),
  beforeInput: beginEditorInput,
  beginComposition: beginEditorComposition,
  endComposition: endEditorComposition,
  rememberSelection: rememberEditorSelection,
  consumeSelection: consumeEditorSelectionRestore,
  peekSelection: peekEditorSelectionRestore,
  restoreSelection: restoreLargeEditorSelection,
  suspendSelection: suspendLargeEditorSelection,
  undo: undoEditorEdit,
  clearLocation: () => useEditorLocation.getState().clear(),
  bindShortcuts: bindShortcutProvider,
  shortcutCandidates: scopedShortcutCandidates,
  ConflictDialog: EditorConflictDialog,
};
