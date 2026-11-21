import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { EditorWindowCommand, EditorPatch, EditorWindowAck } from "./editorWindowModel";
import { editorWindowTabId } from "./editorWindowRegistration";
import {
  editorDocument,
  useEditors,
  beginEditorInput,
  beginEditorComposition,
  endEditorComposition,
  rememberEditorSelection,
  undoEditorEdit,
  consumeEditorSelectionRestore,
  type EditorSelectionSnapshot,
} from "@/store/editors";
import { mainEditorPageServices, editorShortcutCommands } from "./mainEditorPageServices";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { syntaxProviders } from "@/lib/plugins/syntax";
import { runSyntaxHighlighting } from "@/lib/plugins/syntaxRunner";
import { reviewEditorWindow } from "./editorWindowReview";
import { useWorkspace } from "@/store/workspace";
import { api } from "@/lib/api/ipc";
import type { TextEncoding } from "@/lib/api/types";
function invalid(): never {
  throw new Error("editor.documentChanged");
}
const encodings = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "gb18030",
  "gbk",
  "big5",
  "shift-jis",
  "euc-jp",
  "euc-kr",
  "windows-1252",
];
function selection(value: unknown, length: number): EditorSelectionSnapshot | null {
  if (value === null || value === undefined) return null;
  const s = value as EditorSelectionSnapshot;
  if (
    !Number.isInteger(s.start) ||
    !Number.isInteger(s.end) ||
    s.start < 0 ||
    s.end < s.start ||
    s.end > length ||
    !["forward", "backward", "none"].includes(s.direction) ||
    ![s.scrollTop, s.scrollLeft].every((n) => n === undefined || (Number.isFinite(n) && n >= 0))
  )
    invalid();
  return {
    start: s.start,
    end: s.end,
    direction: s.direction,
    scrollTop: s.scrollTop,
    scrollLeft: s.scrollLeft,
  };
}
export async function executeEditorWindowAction(
  lease: PanelLease,
  command: EditorWindowCommand,
  show: () => Promise<unknown>,
): Promise<unknown> {
  const tabId = editorWindowTabId(lease.panelId);
  if (!tabId) invalid();
  const entry = useEditors.getState().entries[tabId];
  if (!entry) invalid();
  const d = command.data;
  if (command.operation === "retryOpen") {
    await useEditors.getState().retryOpen(tabId);
    return null;
  }
  if (command.operation === "clipboard") {
    if (typeof d.text !== "string" || new TextEncoder().encode(d.text).length > 2 * 1024 * 1024)
      invalid();
    await api.clipboardWriteText(d.text);
    return null;
  }
  if (command.operation === "recover") {
    if (
      typeof d.content !== "string" ||
      new TextEncoder().encode(d.content).length > 2 * 1024 * 1024 ||
      typeof d.encoding !== "string" ||
      !encodings.includes(d.encoding)
    )
      invalid();
    if (entry.sessionId !== null && !entry.recoveryTarget) invalid();
    const id = crypto.randomUUID();
    // A new recovery document, never an overwrite of the externally changed buffer.
    useWorkspace.getState().restoreEditorDraft({
      id,
      path: entry.path,
      source: entry.recoveryTarget
        ? { kind: "remote", ...entry.recoveryTarget }
        : { kind: "local" },
      content: d.content,
      baseline: entry.baseline,
      encoding: d.encoding as TextEncoding,
      bom: d.bom === true,
      baselineEncoding: entry.baselineEncoding,
      baselineBom: entry.baselineBom,
    });
    await show();
    return { tabId: `editor:recovered:${id}` };
  }
  // Encoding has its own CAS because changing output format doesn't bump text version.
  if (
    entry.documentId !== d.documentId ||
    entry.version !== d.version ||
    (entry.encoding ?? "utf-8") !== d.encoding
  )
    invalid();
  const ack = (): EditorWindowAck => {
    const e = useEditors.getState().entries[tabId];
    if (!e?.documentId || e.version === undefined) invalid();
    return {
      documentId: e.documentId,
      version: e.version,
      selection: consumeEditorSelectionRestore(tabId, e.documentId, e.version, e.content),
    };
  };
  switch (command.operation) {
    case "edit": {
      if (
        entry.loading ||
        entry.error ||
        entry.disconnected ||
        !Array.isArray(d.edits) ||
        d.edits.length > 256
      )
        invalid();
      let content = entry.content;
      const edits = d.edits as EditorPatch[];
      const prepared: {
        edit: EditorPatch;
        content: string;
        before: EditorSelectionSnapshot | null;
        after: EditorSelectionSnapshot | null;
      }[] = [];
      // Validate the entire batch BEFORE mutating canonical text/history.
      for (const edit of edits) {
        if (
          !Number.isInteger(edit.from) ||
          !Number.isInteger(edit.to) ||
          edit.from < 0 ||
          edit.to < edit.from ||
          edit.to > content.length ||
          typeof edit.insert !== "string" ||
          typeof edit.inputType !== "string" ||
          edit.inputType.length > 128
        )
          invalid();
        const before = selection(edit.before, content.length);
        content = content.slice(0, edit.from) + edit.insert + content.slice(edit.to);
        if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) invalid();
        prepared.push({ edit, content, before, after: selection(edit.after, content.length) });
      }
      for (const p of prepared) {
        const composition = p.edit.inputType === "insertCompositionText";
        if (composition) beginEditorComposition(tabId, p.before);
        else beginEditorInput(tabId, p.edit.inputType, p.before);
        useEditors.getState().change(tabId, p.content, p.after);
        if (composition) endEditorComposition(tabId, p.after);
        rememberEditorSelection(tabId, p.after);
      }
      return ack();
    }
    case "undo":
      rememberEditorSelection(tabId, selection(d.selection, entry.content.length));
      undoEditorEdit(tabId, d.redo === true);
      return ack();
    case "save":
      return useEditors.getState().save(tabId);
    case "encoding":
    case "reopen": {
      if (typeof d.next !== "string" || !encodings.includes(d.next)) invalid();
      return command.operation === "encoding"
        ? useEditors.getState().changeSaveEncoding(tabId, d.next as TextEncoding)
        : useEditors.getState().reopen(tabId, d.next as TextEncoding);
    }
    case "setup":
      if (!entry.sessionId) invalid();
      await show();
      return mainEditorPageServices.setup(entry.sessionId, entry.path);
    case "reconnect": {
      const candidate = useSsh
        .getState()
        .sessions.find(
          (s) =>
            s.id === d.sessionId &&
            s.hostId === entry.recoveryTarget?.hostId &&
            s.address === entry.recoveryTarget.address &&
            !s.purpose,
        );
      if (!candidate) invalid();
      return useEditors.getState().reconnect(tabId, candidate.id, d.accept === true, {
        hostId: candidate.hostId,
        address: candidate.address,
      });
    }
    case "format":
      await show();
      mainEditorPageServices.format(tabId);
      return null;
    case "review":
      await show();
      await reviewEditorWindow(tabId);
      return null;
    case "plugin": {
      const plugin = editorShortcutCommands(entry.path, usePlugins.getState().items).find(
        (c) => c.id === d.id,
      )?.plugin;
      if (!plugin) invalid();
      await show();
      return mainEditorPageServices.openPluginAction(plugin, editorDocument(tabId));
    }
    case "syntax": {
      const document = editorDocument(tabId);
      const range = d.range as { from: number; to: number };
      if (
        !document ||
        !range ||
        !Number.isInteger(range.from) ||
        !Number.isInteger(range.to) ||
        range.from < 0 ||
        range.to < range.from ||
        range.to > document.content.length
      )
        invalid();
      const provider = syntaxProviders(entry.path, usePlugins.getState().items).find((p) =>
        usePlugins.getState().items.some((i) => i.id === p.id && i.status === "running"),
      );
      if (!provider) return [];
      const tokens = await runSyntaxHighlighting(
        {
          provider,
          document,
          window: { offset: range.from, length: Math.min(range.to - range.from, 32768) },
        },
        new AbortController().signal,
      );
      // Bounded reply; next visible range will request the remaining viewport.
      return (tokens ?? [])
        .slice(0, 700)
        .map((t) => ({ ...t, start: t.start + range.from, end: t.end + range.from }));
    }
  }
}
