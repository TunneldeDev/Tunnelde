// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { api } from "@/lib/ipc";
import type { Host, SshSession, TabKind, TabRecord } from "@/lib/types";
import { fileName, useEditors } from "@/store/editors";

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  hostId: string | null;
  pinned: boolean;
}

export type PageKind = "welcome" | "settings" | "about" | "updates";

const PAGE_TITLES: Record<PageKind, string> = {
  welcome: "welcome",
  settings: "settings",
  about: "about",
  updates: "updates",
};

const SUPPORTED_KINDS: TabKind[] = ["welcome", "host", "settings", "about", "updates"];

interface WorkspaceStore {
  tabs: WorkspaceTab[];
  activeId: string | null;
  openPage: (kind: PageKind) => void;
  openHost: (host: Host) => void;
  openTerminal: (session: SshSession) => void;
  openSftp: (session: SshSession) => void;
  openEditor: (session: SshSession, path: string) => void;
  closeSession: (sessionId: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  activate: (id: string) => void;
  togglePin: (id: string) => void;
  reorder: (from: number, to: number) => void;
  hydrate: (records: TabRecord[]) => void;
  removeHost: (hostId: string) => void;
  renameHost: (hostId: string, title: string) => void;
  ensureWelcome: () => void;
}

function neighbour(tabs: WorkspaceTab[], closingIndex: number, closingId: string): string | null {
  const remaining = tabs.filter((tab) => tab.id !== closingId);
  const next = remaining[Math.min(closingIndex, remaining.length - 1)];
  return next?.id ?? null;
}

export const useWorkspace = create<WorkspaceStore>((set) => ({
  tabs: [],
  activeId: null,

  openPage: (kind) => {
    const id = `page:${kind}`;
    set((state) => {
      if (state.tabs.some((tab) => tab.id === id)) {
        return { activeId: id };
      }
      const tab: WorkspaceTab = {
        id,
        kind,
        title: PAGE_TITLES[kind],
        hostId: null,
        pinned: false,
      };
      return { tabs: [...state.tabs, tab], activeId: id };
    });
  },

  openHost: (host) => {
    const id = `host:${host.id}`;
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === id);
      if (existing) {
        return {
          activeId: id,
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title: host.name } : tab)),
        };
      }
      const tab: WorkspaceTab = {
        id,
        kind: "host",
        title: host.name,
        hostId: host.id,
        pinned: false,
      };
      return { tabs: [...state.tabs, tab], activeId: id };
    });
  },

  openTerminal: (session) => {
    const id = `terminal:${session.id}`;
    set((state) => {
      if (state.tabs.some((tab) => tab.id === id)) {
        return { activeId: id };
      }
      const tab: WorkspaceTab = {
        id,
        kind: "terminal",
        title: session.title,
        hostId: session.hostId,
        pinned: false,
      };
      return { tabs: [...state.tabs, tab], activeId: id };
    });
  },

  openSftp: (session) => {
    const id = `sftp:${session.id}`;
    set((state) => {
      if (state.tabs.some((tab) => tab.id === id)) {
        return { activeId: id };
      }
      const tab: WorkspaceTab = {
        id,
        kind: "sftp",
        title: session.title,
        hostId: session.hostId,
        pinned: false,
      };
      return { tabs: [...state.tabs, tab], activeId: id };
    });
  },

  openEditor: (session, path) => {
    const id = `editor:${session.id}:${path}`;
    set((state) => {
      if (state.tabs.some((tab) => tab.id === id)) {
        return { activeId: id };
      }
      const tab: WorkspaceTab = {
        id,
        kind: "editor",
        title: fileName(path),
        hostId: session.hostId,
        pinned: false,
      };
      return { tabs: [...state.tabs, tab], activeId: id };
    });
    if (!useEditors.getState().entries[id]) {
      void useEditors.getState().open(id, session.id, path);
    }
  },

  closeSession: (sessionId) => {
    const matches = (id: string) =>
      id === `terminal:${sessionId}` ||
      id === `sftp:${sessionId}` ||
      id.startsWith(`editor:${sessionId}:`);

    set((state) => {
      const index = state.tabs.findIndex((tab) => matches(tab.id));
      if (index < 0) {
        return state;
      }
      for (const tab of state.tabs) {
        if (tab.kind === "editor" && matches(tab.id)) {
          useEditors.getState().discard(tab.id);
        }
      }
      const tabs = state.tabs.filter((tab) => !matches(tab.id));
      const activeId =
        state.activeId && matches(state.activeId)
          ? neighbour(state.tabs, index, state.activeId)
          : state.activeId;
      return { tabs, activeId };
    });
  },

  close: (id) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const activeId = state.activeId === id ? neighbour(state.tabs, index, id) : state.activeId;
      return { tabs, activeId };
    });
  },

  closeOthers: (id) => {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id === id || tab.pinned);
      return { tabs, activeId: id };
    });
  },

  activate: (id) => set({ activeId: id }),

  togglePin: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
    })),

  reorder: (from, to) =>
    set((state) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= state.tabs.length ||
        to >= state.tabs.length
      ) {
        return state;
      }
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      if (!moved) {
        return state;
      }
      tabs.splice(to, 0, moved);
      return { tabs };
    }),

  hydrate: (records) => {
    const tabs: WorkspaceTab[] = [];
    for (const record of records) {
      if (!SUPPORTED_KINDS.includes(record.kind)) {
        continue;
      }
      if (record.kind === "host" && !record.hostId) {
        continue;
      }
      tabs.push({
        id: record.id,
        kind: record.kind,
        title: record.title,
        hostId: record.hostId,
        pinned: record.pinned,
      });
    }
    set({ tabs, activeId: tabs[0]?.id ?? null });
  },

  removeHost: (hostId) =>
    set((state) => {
      const id = `host:${hostId}`;
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const activeId = state.activeId === id ? neighbour(state.tabs, index, id) : state.activeId;
      return { tabs, activeId };
    }),

  renameHost: (hostId, title) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === `host:${hostId}` ? { ...tab, title } : tab)),
    })),

  ensureWelcome: () =>
    set((state) => {
      if (state.tabs.length > 0) {
        return state;
      }
      const tab: WorkspaceTab = {
        id: "page:welcome",
        kind: "welcome",
        title: PAGE_TITLES.welcome,
        hostId: null,
        pinned: false,
      };
      return { tabs: [tab], activeId: tab.id };
    }),
}));

export function persistWorkspace(): void {
  const { tabs } = useWorkspace.getState();
  const records: TabRecord[] = tabs.map((tab, index) => ({
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    hostId: tab.hostId,
    sortOrder: index,
    pinned: tab.pinned,
    state: null,
  }));
  void api.saveTabs(records).catch(() => undefined);
}
