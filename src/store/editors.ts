import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";
import { isIpcError, type TextEncoding } from "@/lib/api/types";
import type { EditorDraft } from "@/lib/editor/recovery/contracts";

import {
  createFileReadResource,
  readFileText,
  type FileReadResource,
} from "@/lib/files/resources/read";

export const EDITOR_DOCUMENT_MAX_BYTES = 128 * 1024;

export interface EditorEntry {
  recoveryTarget?: { hostId: string; address: string };
  recovered?: boolean;
  tabId: string;
  sessionId: string | null;
  path: string;
  name: string;
  content: string;
  baseline: string;
  /** Older in-memory checkpoints may omit these fields. */
  encoding?: TextEncoding;
  bom?: boolean;
  /** Strict format of the on-disk baseline used for optimistic save checks. */
  baselineEncoding?: TextEncoding;
  baselineBom?: boolean;
  /** False until a successful initial read; older checkpoints infer it from load state. */
  baselineLoaded?: boolean;
  /** An initial decode error may be retried with an explicit safe encoding. */
  decodeError?: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  saveFailure?: string;
  saveConflict?: boolean;
  disconnected?: boolean;
  documentId?: string;
  version?: number;
}

interface EditorsStore {
  entries: Record<string, EditorEntry>;
  open: (
    tabId: string,
    sessionId: string | null,
    path: string,
    target?: EditorEntry["recoveryTarget"],
  ) => Promise<void>;
  retryOpen: (tabId: string) => Promise<void>;
  change: (tabId: string, content: string, selection?: EditorSelectionSnapshot | null) => void;
  changeSaveEncoding: (tabId: string, encoding: TextEncoding) => boolean;
  reopen: (tabId: string, encoding: TextEncoding) => Promise<boolean>;
  save: (tabId: string) => Promise<boolean>;
  resolveConflict: (
    document: EditorDocument,
    disk: EditorDiskVersion,
    action: "reload" | "replace",
  ) => Promise<boolean>;
  discard: (tabId: string) => void;
  isDirty: (tabId: string) => boolean;
  markDisconnected: (sessionId: string) => void;
  reconnect: (
    tabId: string,
    sessionId: string,
    acceptChanges?: boolean,
    target?: EditorEntry["recoveryTarget"],
  ) => Promise<"ready" | "conflict" | "failed">;
}

const versions = new Map<string, symbol>();
const RETRYABLE_DECODE_ERRORS = ["sftp.binaryFile", "sftp.unsupportedEncoding"];
function isDecodeError(error: unknown) {
  return isIpcError(error) && RETRYABLE_DECODE_ERRORS.includes(error.message);
}
/** A draft can differ from disk in text or in its selected output format. */
function hasPendingFormat(entry: EditorEntry) {
  return (
    (entry.baselineEncoding !== undefined &&
      entry.baselineEncoding !== (entry.encoding ?? "utf-8")) ||
    (entry.baselineBom !== undefined && entry.baselineBom !== (entry.bom ?? false))
  );
}
export function editorHasPendingChanges(entry: EditorEntry) {
  return entry.content !== entry.baseline || hasPendingFormat(entry);
}

const saves = new Map<string, { version: symbol; operation: Promise<boolean> }>();
const reads = new Map<string, FileReadResource>();
function cancelRead(tabId: string) {
  const resource = reads.get(tabId);
  reads.delete(tabId);
  resource?.scope.dispose();
}
function beginRead(tabId: string, sessionId: string | null, path: string) {
  cancelRead(tabId);
  const resource = createFileReadResource(
    path,
    sessionId === null ? { kind: "local" } : { kind: "remote", sessionId },
  );
  reads.set(tabId, resource);
  return resource;
}
function finishRead(tabId: string, resource: FileReadResource) {
  if (reads.get(tabId) === resource) reads.delete(tabId);
  resource.scope.dispose();
}
export type EditorSelectionDirection = "forward" | "backward" | "none";
export interface EditorSelectionSnapshot {
  start: number;
  end: number;
  direction: EditorSelectionDirection;
  scrollTop?: number;
  scrollLeft?: number;
}

export interface EditorHistoryItem {
  content: string;
  selection: EditorSelectionSnapshot | null;
}

interface EditHistory {
  undo: EditorHistoryItem[];
  redo: EditorHistoryItem[];
  typedAt: number;
  lastInputType: string | null;
  lastAfter: EditorHistoryItem | null;
}

interface PendingInput {
  documentId?: string;
  content: string;
  inputType: string;
  selection: EditorSelectionSnapshot | null;
}

interface CompositionInput {
  documentId?: string;
  before: EditorHistoryItem;
  final: EditorHistoryItem;
}

interface PendingSelectionRestore {
  documentId: string;
  version: number;
  content: string;
  selection: EditorSelectionSnapshot;
}

const histories = new Map<string, EditHistory>();
const selections = new Map<string, EditorSelectionSnapshot>();
const pendingInputs = new Map<string, PendingInput>();
const compositions = new Map<string, CompositionInput>();
const selectionRestores = new Map<string, PendingSelectionRestore>();

/** Only native in-memory tray checkpoints retain undo text; never persist it on disk. */
export interface EditorHistoryCheckpoint {
  documentId: string;
  undo: Array<EditorHistoryItem | string>;
  redo: Array<EditorHistoryItem | string>;
}

function cloneSelection(selection: EditorSelectionSnapshot | null): EditorSelectionSnapshot | null {
  return selection ? { ...selection } : null;
}

function cloneHistoryItem(item: EditorHistoryItem): EditorHistoryItem {
  return { content: item.content, selection: cloneSelection(item.selection) };
}

function sameSelection(
  left: EditorSelectionSnapshot | null,
  right: EditorSelectionSnapshot | null,
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.start === right.start &&
      left.end === right.end &&
      left.direction === right.direction)
  );
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSelection(value: unknown, contentLength: number): EditorSelectionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const selection = value as Record<string, unknown>;
  if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end)) return null;
  const direction = selection.direction;
  if (direction !== "forward" && direction !== "backward" && direction !== "none") return null;
  const end = Math.max(0, Math.min(contentLength, selection.end as number));
  const start = Math.max(0, Math.min(end, selection.start as number));
  const scrollTop = finite(selection.scrollTop);
  const scrollLeft = finite(selection.scrollLeft);
  return {
    start,
    end,
    direction,
    ...(scrollTop === undefined ? {} : { scrollTop }),
    ...(scrollLeft === undefined ? {} : { scrollLeft }),
  };
}

function commonAffixes(from: string, to: string) {
  let prefix = 0;
  const limit = Math.min(from.length, to.length);
  while (prefix < limit && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    from.charCodeAt(from.length - suffix - 1) === to.charCodeAt(to.length - suffix - 1)
  )
    suffix += 1;
  return { prefix, suffix };
}

function diffSelection(from: string, to: string): EditorSelectionSnapshot {
  const { prefix, suffix } = commonAffixes(from, to);
  const end = Math.max(prefix, to.length - suffix);
  return { start: prefix, end, direction: end === prefix ? "none" : "forward" };
}

function breakCoalescing(history: EditHistory | undefined) {
  if (!history) return;
  history.typedAt = 0;
  history.lastInputType = null;
  history.lastAfter = null;
}

function clearEditorTransients(tabId: string, clearSelection = false) {
  pendingInputs.delete(tabId);
  compositions.delete(tabId);
  selectionRestores.delete(tabId);
  if (clearSelection) selections.delete(tabId);
}

function clearEditorHistory(tabId: string) {
  histories.delete(tabId);
  clearEditorTransients(tabId, true);
}

function normalizeCheckpointItem(value: unknown): EditorHistoryItem | null {
  if (typeof value === "string") return { content: value, selection: null };
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.content !== "string") return null;
  if (item.selection === undefined || item.selection === null)
    return { content: item.content, selection: null };
  const selection = normalizeSelection(item.selection, item.content.length);
  return selection ? { content: item.content, selection } : null;
}

function normalizeCheckpointItems(value: unknown): EditorHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = normalizeCheckpointItem(item);
    return normalized ? [normalized] : [];
  });
}

export function editorHistorySnapshot(): Record<string, EditorHistoryCheckpoint> {
  return Object.fromEntries(
    [...histories].flatMap(([tabId, history]) => {
      const entry = useEditors.getState().entries[tabId];
      return entry?.documentId
        ? [
            [
              tabId,
              {
                documentId: entry.documentId,
                undo: history.undo.map(cloneHistoryItem),
                redo: history.redo.map(cloneHistoryItem),
              },
            ],
          ]
        : [];
    }),
  );
}

export function restoreEditorHistory(snapshot: Record<string, EditorHistoryCheckpoint> = {}) {
  histories.clear();
  pendingInputs.clear();
  compositions.clear();
  selectionRestores.clear();
  selections.clear();
  for (const [tabId, history] of Object.entries(snapshot)) {
    if (
      !history ||
      typeof history !== "object" ||
      typeof history.documentId !== "string" ||
      useEditors.getState().entries[tabId]?.documentId !== history.documentId
    )
      continue;
    const undo = normalizeCheckpointItems(history.undo);
    const redo = normalizeCheckpointItems(history.redo);
    trimHistory(undo);
    trimHistory(redo);
    histories.set(tabId, {
      undo,
      redo,
      typedAt: 0,
      lastInputType: null,
      lastAfter: null,
    });
  }
}

function trimHistory(items: EditorHistoryItem[]) {
  let size = items.reduce((sum, item) => sum + item.content.length * 2, 0);
  while (items.length > 50 || size > 4 * 1024 * 1024) size -= items.shift()!.content.length * 2;
}

function coalescibleInputType(inputType: string): boolean {
  return (
    inputType === "insertText" ||
    inputType === "deleteContentBackward" ||
    inputType === "deleteContentForward"
  );
}

function recordEdit(
  entry: EditorEntry,
  before: EditorHistoryItem,
  after: EditorHistoryItem,
  inputType: string,
  coalesce: boolean,
) {
  const history = histories.get(entry.tabId) ?? {
    undo: [],
    redo: [],
    typedAt: 0,
    lastInputType: null,
    lastAfter: null,
  };
  const now = Date.now();
  const merge =
    coalesce &&
    history.typedAt > 0 &&
    now - history.typedAt <= 750 &&
    history.lastInputType === inputType &&
    history.lastAfter?.content === before.content &&
    sameSelection(history.lastAfter.selection, before.selection);
  if (!merge) {
    history.undo.push(cloneHistoryItem(before));
    trimHistory(history.undo);
  }
  history.redo = [];
  history.typedAt = coalesce ? now : 0;
  history.lastInputType = coalesce ? inputType : null;
  history.lastAfter = cloneHistoryItem(after);
  histories.set(entry.tabId, history);
}

export function rememberEditorSelection(tabId: string, selection: EditorSelectionSnapshot | null) {
  const entry = useEditors.getState().entries[tabId];
  if (!entry) return;
  if (!selection) {
    selections.delete(tabId);
    breakCoalescing(histories.get(tabId));
    return;
  }
  const normalized = normalizeSelection(selection, entry.content.length);
  if (!normalized) return;
  selections.set(tabId, normalized);
  const history = histories.get(tabId);
  if (!history) return;
  if (history.lastAfter && sameSelection(history.lastAfter.selection, normalized)) {
    history.lastAfter = { content: history.lastAfter.content, selection: normalized };
  } else if (history.typedAt) breakCoalescing(history);
}

export function beginEditorInput(
  tabId: string,
  inputType: string,
  selection: EditorSelectionSnapshot | null,
) {
  const entry = useEditors.getState().entries[tabId];
  if (!entry || entry.loading || compositions.has(tabId)) return;
  rememberEditorSelection(tabId, selection);
  pendingInputs.set(tabId, {
    documentId: entry.documentId,
    content: entry.content,
    inputType,
    selection: cloneSelection(selections.get(tabId) ?? null),
  });
}

export function beginEditorComposition(tabId: string, selection: EditorSelectionSnapshot | null) {
  const entry = useEditors.getState().entries[tabId];
  if (!entry || entry.loading) return;
  pendingInputs.delete(tabId);
  rememberEditorSelection(tabId, selection);
  breakCoalescing(histories.get(tabId));
  const before = {
    content: entry.content,
    selection: cloneSelection(selections.get(tabId) ?? null),
  };
  compositions.set(tabId, {
    documentId: entry.documentId,
    before,
    final: cloneHistoryItem(before),
  });
}

export function endEditorComposition(
  tabId: string,
  selection: EditorSelectionSnapshot | null = null,
) {
  const composition = compositions.get(tabId);
  if (!composition) return;
  compositions.delete(tabId);
  const entry = useEditors.getState().entries[tabId];
  if (
    !entry ||
    (composition.documentId && entry.documentId && composition.documentId !== entry.documentId)
  )
    return;
  const finalSelection =
    normalizeSelection(selection, entry.content.length) ??
    cloneSelection(selections.get(tabId) ?? null) ??
    diffSelection(composition.before.content, entry.content);
  const final = { content: entry.content, selection: finalSelection };
  rememberEditorSelection(tabId, finalSelection);
  if (entry.content !== composition.before.content) {
    recordEdit(entry, composition.before, final, "insertCompositionText", false);
  }
}

export function peekEditorSelectionRestore(
  tabId: string,
  documentId: string,
  version: number,
  content: string,
): EditorSelectionSnapshot | null {
  const request = selectionRestores.get(tabId);
  if (
    !request ||
    request.documentId !== documentId ||
    request.version !== version ||
    request.content !== content
  )
    return null;
  return cloneSelection(request.selection);
}

export function consumeEditorSelectionRestore(
  tabId: string,
  documentId: string,
  version: number,
  content: string,
): EditorSelectionSnapshot | null {
  const request = selectionRestores.get(tabId);
  if (!request) return null;
  selectionRestores.delete(tabId);
  if (
    request.documentId !== documentId ||
    request.version !== version ||
    request.content !== content
  )
    return null;
  return cloneSelection(request.selection);
}

function queueSelectionRestore(
  tabId: string,
  entry: Pick<EditorEntry, "documentId" | "version">,
  content: string,
  selection: EditorSelectionSnapshot | null,
) {
  if (!entry.documentId || entry.version === undefined || !selection) return;
  selectionRestores.set(tabId, {
    documentId: entry.documentId,
    version: entry.version,
    content,
    selection: cloneSelection(selection)!,
  });
}

export interface EditorDocument {
  tabId: string;
  documentId: string;
  version: number;
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

export interface EditorDiskVersion {
  content: string;
  encoding: TextEncoding;
  bom: boolean;
}

/** Upgrade an older window checkpoint lazily, without exposing internal editor state. */
export function editorDocument(tabId: string): EditorDocument | null {
  let entry = useEditors.getState().entries[tabId];
  if (!entry || entry.loading || entry.error || entry.disconnected) return null;
  if (!entry.documentId || entry.version === undefined) {
    entry = { ...entry, documentId: crypto.randomUUID(), version: 0 };
    const upgraded = entry;
    useEditors.setState((state) => ({ entries: { ...state.entries, [tabId]: upgraded } }));
  }
  return {
    tabId,
    documentId: entry.documentId!,
    version: entry.version!,
    path: entry.path,
    name: entry.name,
    content: entry.content,
    dirty: editorHasPendingChanges(entry),
  };
}

export function replaceEditorDocument(
  document: Pick<EditorDocument, "tabId" | "documentId" | "version">,
  text: string,
) {
  const entry = useEditors.getState().entries[document.tabId];
  if (
    !entry ||
    entry.loading ||
    entry.error ||
    entry.disconnected ||
    entry.documentId !== document.documentId ||
    entry.version !== document.version
  )
    throw new Error("editor.documentChanged");
  if (entry.content !== text) {
    const before = {
      content: entry.content,
      selection: cloneSelection(selections.get(entry.tabId) ?? null),
    };
    const afterSelection = diffSelection(entry.content, text);
    const after = { content: text, selection: afterSelection };
    clearEditorTransients(entry.tabId);
    recordEdit(entry, before, after, "insertReplacementText", false);
    const replaced = {
      ...entry,
      content: text,
      documentId: entry.documentId ?? crypto.randomUUID(),
      version: document.version + 1,
    };
    rememberEditorSelection(entry.tabId, afterSelection);
    queueSelectionRestore(entry.tabId, replaced, text, afterSelection);
    useEditors.setState((state) => ({
      entries: { ...state.entries, [entry.tabId]: replaced },
    }));
  }
  return editorDocument(entry.tabId)!;
}

export function undoEditorEdit(tabId: string, redo = false): boolean {
  const entry = useEditors.getState().entries[tabId];
  const history = histories.get(tabId);
  if (!entry || entry.loading || entry.error || !history) return false;
  const source = redo ? history.redo : history.undo;
  const item = source.pop();
  if (!item) return false;
  const currentSelection = cloneSelection(selections.get(tabId) ?? null);
  const target = redo ? history.undo : history.redo;
  target.push({ content: entry.content, selection: currentSelection });
  trimHistory(target);
  clearEditorTransients(tabId);
  breakCoalescing(history);
  const restoredSelection = item.selection
    ? cloneSelection(item.selection)!
    : diffSelection(entry.content, item.content);
  const restored = {
    ...entry,
    content: item.content,
    documentId: entry.documentId ?? crypto.randomUUID(),
    version: (entry.version ?? 0) + 1,
  };
  rememberEditorSelection(tabId, restoredSelection);
  queueSelectionRestore(tabId, restored, item.content, restoredSelection);
  useEditors.setState((state) => ({
    entries: { ...state.entries, [tabId]: restored },
  }));
  return true;
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function restoreEditorDraft(tabId: string, draft: EditorDraft): void {
  if (useEditors.getState().entries[tabId]) return;
  versions.set(tabId, Symbol());
  const remote = draft.source.kind === "remote";
  useEditors.setState((state) => ({
    entries: {
      ...state.entries,
      [tabId]: {
        tabId,
        sessionId: remote ? "recovered" : null,
        path: draft.path,
        name: fileName(draft.path),
        content: draft.content,
        baseline: draft.baseline,
        encoding: draft.encoding ?? "utf-8",
        bom: draft.bom ?? false,
        baselineEncoding: draft.baselineEncoding ?? draft.encoding,
        baselineBom: draft.baselineBom ?? draft.bom,
        baselineLoaded: true,
        loading: false,
        saving: false,
        error: null,
        decodeError: false,
        disconnected: remote,
        documentId: draft.id,
        version: 0,
        recovered: true,
        ...(draft.source.kind === "remote"
          ? { recoveryTarget: { hostId: draft.source.hostId, address: draft.source.address } }
          : {}),
      },
    },
  }));
}

export const useEditors = create<EditorsStore>((set, get) => ({
  entries: {},

  open: async (tabId, sessionId, path, target) => {
    clearEditorHistory(tabId);
    saves.delete(tabId);
    const resource = beginRead(tabId, sessionId, path);
    const version = Symbol();
    versions.set(tabId, version);
    set((state) => ({
      entries: {
        ...state.entries,
        [tabId]: {
          tabId,
          sessionId,
          path,
          name: fileName(path),
          content: "",
          baseline: "",
          encoding: "utf-8",
          bom: false,
          baselineLoaded: false,
          loading: true,
          saving: false,
          error: null,
          decodeError: false,
          disconnected: false,
          documentId: crypto.randomUUID(),
          version: 0,
          recoveryTarget: target,
        },
      },
    }));

    try {
      const file = await readFileText(resource, "editor");
      if (versions.get(tabId) !== version) return;
      set((state) => {
        const current = state.entries[tabId];
        if (!current) {
          return state;
        }
        return {
          entries: {
            ...state.entries,
            [tabId]: {
              ...current,
              content: file.content,
              baseline: file.content,
              encoding: file.encoding,
              bom: file.bom,
              baselineEncoding: file.encoding,
              baselineBom: file.bom,
              baselineLoaded: true,
              loading: false,
              error: null,
              decodeError: false,
            },
          },
        };
      });
    } catch (error) {
      if (versions.get(tabId) !== version) return;
      set((state) => {
        const current = state.entries[tabId];
        if (!current) {
          return state;
        }
        return {
          entries: {
            ...state.entries,
            [tabId]: {
              ...current,
              loading: false,
              baselineLoaded: false,
              error: translateError(error),
              decodeError: isDecodeError(error),
            },
          },
        };
      });
    } finally {
      finishRead(tabId, resource);
    }
  },

  retryOpen: async (tabId) => {
    const entry = get().entries[tabId];
    if (
      !entry?.error ||
      entry.baselineLoaded !== false ||
      entry.disconnected ||
      entry.loading ||
      entry.saving ||
      editorHasPendingChanges(entry)
    )
      return;
    await get().open(tabId, entry.sessionId, entry.path, entry.recoveryTarget);
  },

  change: (tabId, content, selection) => {
    set((state) => {
      const current = state.entries[tabId];
      if (!current || current.loading || (!current.baselineLoaded && !!current.error)) {
        return state;
      }
      if (current.content === content) {
        if (selection !== undefined) rememberEditorSelection(tabId, selection);
        return state;
      }
      const pending = pendingInputs.get(tabId);
      pendingInputs.delete(tabId);
      const validPending =
        pending &&
        pending.content === current.content &&
        (!pending.documentId || !current.documentId || pending.documentId === current.documentId);
      const before = {
        content: current.content,
        selection: validPending
          ? cloneSelection(pending.selection)
          : cloneSelection(selections.get(tabId) ?? null),
      };
      const inputType = validPending ? pending.inputType : "insertText";
      const afterSelection =
        selection === undefined
          ? diffSelection(current.content, content)
          : (normalizeSelection(selection, content.length) ??
            diffSelection(current.content, content));
      const after = { content, selection: afterSelection };
      if (!compositions.has(tabId)) {
        recordEdit(current, before, after, inputType, coalescibleInputType(inputType));
      } else {
        const composition = compositions.get(tabId)!;
        composition.final = cloneHistoryItem(after);
      }
      return {
        entries: {
          ...state.entries,
          [tabId]: {
            ...current,
            content,
            documentId: current.documentId ?? crypto.randomUUID(),
            version: (current.version ?? 0) + 1,
          },
        },
      };
    });
    const updated = get().entries[tabId];
    if (updated && selection !== undefined) rememberEditorSelection(tabId, selection);
  },

  changeSaveEncoding: (tabId, encoding) => {
    const current = get().entries[tabId];
    if (
      !current ||
      current.loading ||
      current.saving ||
      current.disconnected ||
      current.error ||
      current.baselineLoaded === false
    )
      return false;
    const currentEncoding = current.encoding ?? "utf-8";
    if (currentEncoding === encoding) return true;
    const baselineEncoding = current.baselineEncoding ?? currentEncoding;
    const baselineBom = current.baselineBom ?? current.bom ?? false;
    const bom =
      encoding === baselineEncoding
        ? baselineBom
        : encoding === "utf-16le" || encoding === "utf-16be";
    set((state) => {
      const entry = state.entries[tabId];
      if (!entry) return state;
      return {
        entries: {
          ...state.entries,
          [tabId]: { ...entry, encoding, bom, baselineEncoding, baselineBom },
        },
      };
    });
    return true;
  },

  reopen: async (tabId, encoding) => {
    const current = get().entries[tabId];
    if (
      !current ||
      current.loading ||
      current.saving ||
      current.disconnected ||
      (!!current.error && !current.decodeError) ||
      (current.baselineLoaded === false && !current.decodeError) ||
      editorHasPendingChanges(current)
    )
      return false;
    const version = Symbol();
    versions.set(tabId, version);
    const resource = beginRead(tabId, current.sessionId, current.path);
    set((state) => {
      const entry = state.entries[tabId];
      if (!entry) return state;
      return {
        entries: {
          ...state.entries,
          [tabId]: { ...entry, loading: true, error: null, decodeError: false },
        },
      };
    });
    try {
      const file = await readFileText(resource, "editor", encoding);
      if (versions.get(tabId) !== version || reads.get(tabId) !== resource) return false;
      set((state) => {
        const entry = state.entries[tabId];
        if (!entry) return state;
        return {
          entries: {
            ...state.entries,
            [tabId]: {
              ...entry,
              content: file.content,
              baseline: file.content,
              encoding: file.encoding,
              bom: file.bom,
              baselineEncoding: file.encoding,
              baselineBom: file.bom,
              loading: false,
              baselineLoaded: true,
              decodeError: false,
              documentId: crypto.randomUUID(),
              version: 0,
            },
          },
        };
      });
      clearEditorHistory(tabId);
      return true;
    } catch (error) {
      if (versions.get(tabId) === version && !resource.scope.signal.aborted) {
        const message = translateError(error);
        toast(message, "error");
        set((state) => {
          const entry = state.entries[tabId];
          if (!entry || entry.baselineLoaded !== false) return state;
          return {
            entries: {
              ...state.entries,
              [tabId]: {
                ...entry,
                loading: false,
                error: message,
                decodeError: isDecodeError(error),
              },
            },
          };
        });
      }
      return false;
    } finally {
      if (versions.get(tabId) === version) {
        set((state) => {
          const entry = state.entries[tabId];
          if (!entry) return state;
          return {
            entries: {
              ...state.entries,
              [tabId]: {
                ...entry,
                loading: false,
              },
            },
          };
        });
      }
      finishRead(tabId, resource);
    }
  },

  save: (tabId) => {
    const current = get().entries[tabId];
    if (
      !current ||
      current.loading ||
      current.error ||
      current.disconnected ||
      current.baselineLoaded === false
    ) {
      return Promise.resolve(false);
    }
    const version = versions.get(tabId) ?? Symbol();
    versions.set(tabId, version);
    const pending = saves.get(tabId);
    if (pending?.version === version) return pending.operation;
    if (!editorHasPendingChanges(current)) {
      return Promise.resolve(true);
    }

    set((state) => ({
      entries: { ...state.entries, [tabId]: { ...current, saving: true } },
    }));

    const submitted = current.content;
    const operation = (async () => {
      try {
        if (current.sessionId === null) {
          await api.localWriteText(
            current.path,
            submitted,
            current.baseline,
            current.encoding ?? "utf-8",
            current.bom ?? false,
            current.baselineEncoding,
            current.baselineBom,
          );
        } else {
          await api.sftpWriteText(
            current.sessionId,
            current.path,
            submitted,
            current.baseline,
            current.encoding ?? "utf-8",
            current.bom ?? false,
            current.baselineEncoding,
            current.baselineBom,
          );
        }
        if (versions.get(tabId) !== version || !get().entries[tabId]) return false;
        set((state) => {
          const entry = state.entries[tabId];
          if (!entry) {
            return state;
          }
          return {
            entries: {
              ...state.entries,
              [tabId]: {
                ...entry,
                baseline: submitted,
                baselineEncoding: current.encoding ?? "utf-8",
                baselineBom: current.bom ?? false,
                saving: false,
                saveFailure: undefined,
                saveConflict: false,
              },
            },
          };
        });
        toast(i18n.t("editor.saved"), "success");
        return true;
      } catch (error) {
        if (versions.get(tabId) !== version) return false;
        set((state) => {
          const entry = state.entries[tabId];
          if (!entry) {
            return state;
          }
          return {
            entries: {
              ...state.entries,
              [tabId]: {
                ...entry,
                saving: false,
                saveFailure: translateError(error),
                saveConflict:
                  isIpcError(error) &&
                  [
                    "editor.localFileChanged",
                    "editor.remoteFileChanged",
                    "editor.textFormatChanged",
                  ].includes(error.message),
              },
            },
          };
        });
        const cancelled =
          isIpcError(error) &&
          error.code === "validation" &&
          error.message === "editor.saveCancelled";
        toast(translateError(error), cancelled ? "info" : "error");
        return false;
      }
    })().finally(() => {
      if (saves.get(tabId)?.operation === operation) saves.delete(tabId);
    });
    saves.set(tabId, { version, operation });
    return operation;
  },

  resolveConflict: async (document, disk, action) => {
    const entry = get().entries[document.tabId];
    if (
      !entry ||
      entry.saving ||
      entry.disconnected ||
      entry.documentId !== document.documentId ||
      entry.version !== document.version
    ) {
      toast(i18n.t("editor.reviewStale"), "error");
      return false;
    }
    if (action === "reload") {
      const before = {
        content: entry.content,
        selection: cloneSelection(selections.get(document.tabId) ?? null),
      };
      const afterSelection = diffSelection(entry.content, disk.content);
      clearEditorTransients(document.tabId);
      recordEdit(
        entry,
        before,
        { content: disk.content, selection: afterSelection },
        "reload",
        false,
      );
      const reloaded = {
        ...entry,
        baseline: disk.content,
        content: disk.content,
        encoding: disk.encoding,
        bom: disk.bom,
        baselineEncoding: disk.encoding,
        baselineBom: disk.bom,
        version: (entry.version ?? 0) + 1,
        saveFailure: undefined,
        saveConflict: false,
      };
      rememberEditorSelection(document.tabId, afterSelection);
      queueSelectionRestore(document.tabId, reloaded, disk.content, afterSelection);
      set((state) => ({ entries: { ...state.entries, [document.tabId]: reloaded } }));
    } else {
      set((state) => ({
        entries: {
          ...state.entries,
          [document.tabId]: {
            ...entry,
            baseline: disk.content,
            encoding: entry.encoding,
            bom: entry.bom,
            // The reviewed disk format is the strict source for the next save.
            baselineEncoding: disk.encoding,
            baselineBom: disk.bom,
            saveFailure: undefined,
            saveConflict: false,
          },
        },
      }));
    }
    return action === "replace" ? get().save(document.tabId) : true;
  },

  discard: (tabId) => {
    cancelRead(tabId);
    clearEditorHistory(tabId);
    versions.delete(tabId);
    saves.delete(tabId);
    set((state) => {
      const next = { ...state.entries };
      delete next[tabId];
      return { entries: next };
    });
  },

  isDirty: (tabId) => {
    const entry = get().entries[tabId];
    return !!entry && !entry.loading && editorHasPendingChanges(entry);
  },

  markDisconnected: (sessionId) =>
    set((state) => {
      const entries = { ...state.entries };
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.sessionId !== sessionId) continue;
        cancelRead(id);
        versions.set(id, Symbol());
        saves.delete(id);
        entries[id] = {
          ...entry,
          baselineLoaded: entry.baselineLoaded ?? (!entry.loading && !entry.error),
          disconnected: true,
          saving: false,
          loading: false,
        };
      }
      return { entries };
    }),

  reconnect: async (tabId, sessionId, acceptChanges = false, target) => {
    const current = get().entries[tabId];
    if (!current || !current.disconnected) return "failed";
    if (
      current.recoveryTarget &&
      (current.recoveryTarget.hostId !== target?.hostId ||
        current.recoveryTarget.address !== target?.address)
    ) {
      toast(i18n.t("editor.recoveryDestinationChanged"), "error");
      return "failed";
    }
    const version = versions.get(tabId);
    const resource = beginRead(tabId, sessionId, current.path);
    try {
      // Only a successful/restored baseline carries an explicit decoding
      // choice. A failed initial open still has placeholder UTF-8 metadata and
      // must auto-detect on its first successful reconnect.
      const reviewedEncoding = current.baselineLoaded
        ? (current.baselineEncoding ?? current.encoding)
        : undefined;
      const file = await readFileText(resource, "editor", reviewedEncoding);
      const entry = get().entries[tabId];
      if (
        !entry ||
        versions.get(tabId) !== version ||
        !entry.disconnected ||
        reads.get(tabId) !== resource
      )
        return "failed";
      const baselineLoaded = entry.baselineLoaded ?? (!entry.loading && !entry.error);
      const baselineEncoding = entry.baselineEncoding ?? entry.encoding ?? "utf-8";
      const baselineBom = entry.baselineBom ?? entry.bom ?? false;
      const keepDraft = editorHasPendingChanges(entry);
      const changed =
        file.content !== entry.baseline ||
        file.encoding !== baselineEncoding ||
        file.bom !== baselineBom;
      if (keepDraft && baselineLoaded && changed && !acceptChanges) return "conflict";
      if (!keepDraft && changed) clearEditorHistory(tabId);
      versions.set(tabId, Symbol());
      set((state) => ({
        entries: {
          ...state.entries,
          [tabId]: {
            ...entry,
            sessionId,
            documentId: crypto.randomUUID(),
            version: 0,
            content: keepDraft ? entry.content : file.content,
            baseline: file.content,
            encoding:
              keepDraft && baselineLoaded ? (entry.encoding ?? file.encoding) : file.encoding,
            bom: keepDraft && baselineLoaded ? (entry.bom ?? file.bom) : file.bom,
            // Keep the explicitly selected draft format as the save target;
            // the re-read format is the baseline that must still match.
            baselineEncoding: file.encoding,
            baselineBom: file.bom,
            baselineLoaded: true,
            loading: false,
            saveFailure: undefined,
            saveConflict: false,
            disconnected: false,
            error: null,
            decodeError: false,
          },
        },
      }));
      return "ready";
    } catch (error) {
      if (
        reads.get(tabId) === resource &&
        versions.get(tabId) === version &&
        !resource.scope.signal.aborted
      )
        toast(translateError(error), "error");
      return "failed";
    } finally {
      finishRead(tabId, resource);
    }
  },
}));
