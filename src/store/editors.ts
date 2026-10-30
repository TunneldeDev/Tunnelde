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
}

interface EditorsStore {
  entries: Record<string, EditorEntry>;
  open: (tabId: string, sessionId: string, path: string) => Promise<void>;
  change: (tabId: string, content: string) => void;
  save: (tabId: string) => Promise<boolean>;
  discard: (tabId: string) => void;
  isDirty: (tabId: string) => boolean;
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const useEditors = create<EditorsStore>((set, get) => ({
  entries: {},

  open: async (tabId, sessionId, path) => {
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
        },
      },
    }));

    try {
      const file = await api.sftpReadText(sessionId, path);
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
      if (!current) {
        return state;
      }
      return { entries: { ...state.entries, [tabId]: { ...current, content } } };
    });
  },

  save: async (tabId) => {
    const current = get().entries[tabId];
    if (!current || current.loading || current.error) {
      return false;
    }
    if (current.content === current.baseline) {
      return true;
    }

    set((state) => ({
      entries: { ...state.entries, [tabId]: { ...current, saving: true } },
    }));

    try {
      await api.sftpWriteText(current.sessionId, current.path, current.content);
      set((state) => {
        const entry = state.entries[tabId];
        if (!entry) {
          return state;
        }
        return {
          entries: {
            ...state.entries,
            [tabId]: { ...entry, baseline: entry.content, saving: false },
          },
        };
      });
      toast(i18n.t("editor.saved"), "success");
      return true;
    } catch (error) {
      set((state) => {
        const entry = state.entries[tabId];
        if (!entry) {
          return state;
        }
        return { entries: { ...state.entries, [tabId]: { ...entry, saving: false } } };
      });
      toast(translateError(error), "error");
      return false;
    }
  },

  discard: (tabId) => {
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
}));
