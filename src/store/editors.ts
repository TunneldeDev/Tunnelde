import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";
import { isIpcError } from "@/lib/api/types";

import {
  createFileReadResource,
  readFileText,
  type FileReadResource,
} from "@/lib/files/resources/read";

export const EDITOR_DOCUMENT_MAX_BYTES = 128 * 1024;

export interface EditorEntry {
  tabId: string;
  sessionId: string | null;
  path: string;
  name: string;
  content: string;
  baseline: string;
  /** False until a successful initial read; older checkpoints infer it from load state. */
  baselineLoaded?: boolean;
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
  open: (tabId: string, sessionId: string | null, path: string) => Promise<void>;
  change: (tabId: string, content: string) => void;
  save: (tabId: string) => Promise<boolean>;
  resolveConflict: (
    document: EditorDocument,
    disk: string,
    action: "reload" | "replace",
  ) => Promise<boolean>;
  discard: (tabId: string) => void;
  isDirty: (tabId: string) => boolean;
  markDisconnected: (sessionId: string) => void;
  reconnect: (
    tabId: string,
    sessionId: string,
    acceptChanges?: boolean,
  ) => Promise<"ready" | "conflict" | "failed">;
}

const versions = new Map<string, symbol>();
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
type EditHistory = { undo: string[]; redo: string[]; typedAt: number };
const histories = new Map<string, EditHistory>();

/** Only native in-memory tray checkpoints retain undo text; never persist it on disk. */
export interface EditorHistoryCheckpoint {
  documentId: string;
  undo: string[];
  redo: string[];
}
export function editorHistorySnapshot(): Record<string, EditorHistoryCheckpoint> {
  return Object.fromEntries(
    [...histories].flatMap(([tabId, history]) => {
      const entry = useEditors.getState().entries[tabId];
      return entry?.documentId
        ? [
            [
              tabId,
              { documentId: entry.documentId, undo: [...history.undo], redo: [...history.redo] },
            ],
          ]
        : [];
    }),
  );
}

export function restoreEditorHistory(snapshot: ReturnType<typeof editorHistorySnapshot> = {}) {
  histories.clear();
  for (const [tabId, history] of Object.entries(snapshot)) {
    if (useEditors.getState().entries[tabId]?.documentId !== history.documentId) continue;
    const undo = [...history.undo],
      redo = [...history.redo];
    trimHistory(undo);
    trimHistory(redo);
    histories.set(tabId, { undo, redo, typedAt: 0 });
  }
}

function trimHistory(items: string[]) {
  let size = items.reduce((sum, item) => sum + item.length * 2, 0);
  while (items.length > 50 || size > 4 * 1024 * 1024) size -= items.shift()!.length * 2;
}

function recordEdit(entry: EditorEntry, typing: boolean) {
  const history = histories.get(entry.tabId) ?? { undo: [], redo: [], typedAt: 0 };
  const now = Date.now();
  if (!typing || !history.typedAt || now - history.typedAt > 750) history.undo.push(entry.content);
  trimHistory(history.undo);
  history.redo = [];
  history.typedAt = typing ? now : 0;
  histories.set(entry.tabId, history);
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
    dirty: entry.content !== entry.baseline,
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
    recordEdit(entry, false);
    useEditors.setState((state) => ({
      entries: {
        ...state.entries,
        [entry.tabId]: {
          ...entry,
          content: text,
          version: document.version + 1,
        },
      },
    }));
  }
  return editorDocument(entry.tabId)!;
}

export function undoEditorEdit(tabId: string, redo = false): boolean {
  const entry = useEditors.getState().entries[tabId];
  const history = histories.get(tabId);
  if (!entry || entry.loading || entry.error || !history) return false;
  const source = redo ? history.redo : history.undo;
  const text = source.pop();
  if (text === undefined) return false;
  const target = redo ? history.undo : history.redo;
  target.push(entry.content);
  trimHistory(target);
  history.typedAt = 0;
  useEditors.setState((state) => ({
    entries: {
      ...state.entries,
      [tabId]: {
        ...entry,
        content: text,
        documentId: entry.documentId ?? crypto.randomUUID(),
        version: (entry.version ?? 0) + 1,
      },
    },
  }));
  return true;
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const useEditors = create<EditorsStore>((set, get) => ({
  entries: {},

  open: async (tabId, sessionId, path) => {
    histories.delete(tabId);
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
          baselineLoaded: false,
          loading: true,
          saving: false,
          error: null,
          disconnected: false,
          documentId: crypto.randomUUID(),
          version: 0,
        },
      },
    }));

    try {
      const content = await readFileText(resource, "editor");
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
              content,
              baseline: content,
              baselineLoaded: true,
              loading: false,
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
            [tabId]: { ...current, loading: false, error: translateError(error) },
          },
        };
      });
    } finally {
      finishRead(tabId, resource);
    }
  },

  change: (tabId, content) => {
    set((state) => {
      const current = state.entries[tabId];
      if (!current || current.loading) {
        return state;
      }
      if (current.content === content) return state;
      recordEdit(current, true);
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
  },

  save: (tabId) => {
    const current = get().entries[tabId];
    if (!current || current.loading || current.error || current.disconnected) {
      return Promise.resolve(false);
    }
    const version = versions.get(tabId) ?? Symbol();
    versions.set(tabId, version);
    const pending = saves.get(tabId);
    if (pending?.version === version) return pending.operation;
    if (current.content === current.baseline) {
      return Promise.resolve(true);
    }

    set((state) => ({
      entries: { ...state.entries, [tabId]: { ...current, saving: true } },
    }));

    const submitted = current.content;
    const operation = (async () => {
      try {
        if (current.sessionId === null) {
          await api.localWriteText(current.path, submitted, current.baseline);
        } else {
          await api.sftpWriteText(current.sessionId, current.path, submitted, current.baseline);
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
                  ["editor.localFileChanged", "editor.remoteFileChanged"].includes(error.message),
              },
            },
          };
        });
        toast(translateError(error), "error");
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
    if (action === "reload") recordEdit(entry, false);
    set((state) => ({
      entries: {
        ...state.entries,
        [document.tabId]: {
          ...entry,
          baseline: disk,
          content: action === "reload" ? disk : entry.content,
          version: (entry.version ?? 0) + (action === "reload" ? 1 : 0),
          saveFailure: undefined,
          saveConflict: false,
        },
      },
    }));
    return action === "replace" ? get().save(document.tabId) : true;
  },

  discard: (tabId) => {
    cancelRead(tabId);
    histories.delete(tabId);
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
    return !!entry && !entry.loading && entry.content !== entry.baseline;
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

  reconnect: async (tabId, sessionId, acceptChanges = false) => {
    const current = get().entries[tabId];
    if (!current || !current.disconnected) return "failed";
    const version = versions.get(tabId);
    const resource = beginRead(tabId, sessionId, current.path);
    try {
      const content = await readFileText(resource, "editor");
      const entry = get().entries[tabId];
      if (
        !entry ||
        versions.get(tabId) !== version ||
        !entry.disconnected ||
        reads.get(tabId) !== resource
      )
        return "failed";
      const baselineLoaded = entry.baselineLoaded ?? (!entry.loading && !entry.error);
      if (baselineLoaded && content !== entry.baseline && !acceptChanges) return "conflict";
      versions.set(tabId, Symbol());
      set((state) => ({
        entries: {
          ...state.entries,
          [tabId]: {
            ...entry,
            sessionId,
            documentId: crypto.randomUUID(),
            version: 0,
            content: baselineLoaded || entry.content !== entry.baseline ? entry.content : content,
            baseline: content,
            baselineLoaded: true,
            loading: false,
            saveFailure: undefined,
            saveConflict: false,
            disconnected: false,
            error: null,
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
