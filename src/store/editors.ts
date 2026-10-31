// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";

export interface EditorEntry {
  tabId: string;
  sessionId: string;
  path: string;
  name: string;
  content: string;
  baseline: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  disconnected?: boolean;
}

interface EditorsStore {
  entries: Record<string, EditorEntry>;
  open: (tabId: string, sessionId: string, path: string) => Promise<void>;
  change: (tabId: string, content: string) => void;
  save: (tabId: string) => Promise<boolean>;
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
const saves = new Map<string, Promise<boolean>>();

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const useEditors = create<EditorsStore>((set, get) => ({
  entries: {},

  open: async (tabId, sessionId, path) => {
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
          loading: true,
          saving: false,
          error: null,
          disconnected: false,
        },
      },
    }));

    try {
      const file = await api.sftpReadText(sessionId, path);
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
    }
  },

  change: (tabId, content) => {
    set((state) => {
      const current = state.entries[tabId];
      if (!current || current.loading) {
        return state;
      }
      return { entries: { ...state.entries, [tabId]: { ...current, content } } };
    });
  },

  save: (tabId) => {
    const pending = saves.get(tabId);
    if (pending) return pending;
    const current = get().entries[tabId];
    if (!current || current.loading || current.error || current.disconnected) {
      return Promise.resolve(false);
    }
    if (current.content === current.baseline) {
      return Promise.resolve(true);
    }

    set((state) => ({
      entries: { ...state.entries, [tabId]: { ...current, saving: true } },
    }));

    const version = versions.get(tabId) ?? Symbol();
    versions.set(tabId, version);
    const submitted = current.content;
    const operation = (async () => {
      try {
        await api.sftpWriteText(current.sessionId, current.path, current.content);
        if (versions.get(tabId) !== version || !get().entries[tabId]) return false;
        set((state) => {
          const entry = state.entries[tabId];
          if (!entry) {
            return state;
          }
          return {
            entries: {
              ...state.entries,
              [tabId]: { ...entry, baseline: submitted, saving: false },
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
          return { entries: { ...state.entries, [tabId]: { ...entry, saving: false } } };
        });
        toast(translateError(error), "error");
        return false;
      } finally {
        if (versions.get(tabId) === version) saves.delete(tabId);
      }
    })();
    saves.set(tabId, operation);
    return operation;
  },

  discard: (tabId) => {
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
        versions.set(id, Symbol());
        saves.delete(id);
        entries[id] = { ...entry, disconnected: true, saving: false };
      }
      return { entries };
    }),

  reconnect: async (tabId, sessionId, acceptChanges = false) => {
    const current = get().entries[tabId];
    if (!current || !current.disconnected) return "failed";
    const version = versions.get(tabId);
    try {
      const file = await api.sftpReadText(sessionId, current.path);
      const entry = get().entries[tabId];
      if (!entry || versions.get(tabId) !== version || !entry.disconnected) return "failed";
      if (file.content !== entry.baseline && !acceptChanges) return "conflict";
      versions.set(tabId, Symbol());
      set((state) => ({
        entries: {
          ...state.entries,
          [tabId]: {
            ...entry,
            sessionId,
            baseline: file.content,
            disconnected: false,
            error: null,
          },
        },
      }));
      return "ready";
    } catch (error) {
      toast(translateError(error), "error");
      return "failed";
    }
  },
}));
