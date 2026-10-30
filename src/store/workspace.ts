// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { api } from "@/lib/api/ipc";
import type { Host, SshSession, TabKind, TabRecord } from "@/lib/api/types";
import { fileName, useEditors } from "@/store/editors";

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  hostId: string | null;
  pinned: boolean;
}

export interface WorkspacePane {
  id: string;
  tabIds: string[];
  activeId: string | null;
}

export type SplitDirection = "row" | "column";
/** Where a dragged tab lands relative to the tabs that stay behind. */
export type PanePosition = "before" | "after";

export type PageKind = "welcome" | "settings" | "about" | "updates";

const PAGE_TITLES: Record<PageKind, string> = {
  welcome: "welcome",
  settings: "settings",
  about: "about",
  updates: "updates",
};

const SUPPORTED_KINDS: TabKind[] = ["welcome", "host", "settings", "about", "updates"];

export const FIRST_PANE = "pane-1";
const SECOND_PANE = "pane-2";
const LEADING_PANE = "pane-0";

interface WorkspaceStore {
  tabs: WorkspaceTab[];
  panes: WorkspacePane[];
  activePaneId: string;
  activeId: string | null;
  split: SplitDirection | null;
  openPage: (kind: PageKind) => void;
  openHost: (host: Host) => void;
  openTerminal: (session: SshSession) => void;
  openSftp: (session: SshSession) => void;
  openEditor: (session: SshSession, path: string) => void;
  openHistory: (session: SshSession) => void;
  openMonitor: (session: SshSession) => void;
  openPluginView: (pluginId: string, viewId: string, title: string) => void;
  closeSession: (sessionId: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  activate: (id: string) => void;
  activatePane: (paneId: string) => void;
  togglePin: (id: string) => void;
  reorder: (from: number, to: number) => void;
  splitTab: (tabId: string, direction: SplitDirection, position?: PanePosition) => void;
  moveTab: (tabId: string, targetPaneId: string, beforeTabId?: string | null) => void;
  reorderTab: (tabId: string, beforeTabId: string | null) => void;
  closePane: (paneId: string) => void;
  hydrate: (records: TabRecord[]) => void;
  removeHost: (hostId: string) => void;
  renameHost: (hostId: string, title: string) => void;
  ensureWelcome: () => void;
}

interface PanesState {
  panes: WorkspacePane[];
  activePaneId: string;
  activeId: string | null;
  split: SplitDirection | null;
}

const pane = (id: string): WorkspacePane => ({ id, tabIds: [], activeId: null });

function settle(panes: WorkspacePane[], preferred: string, split: SplitDirection | null): PanesState {
  const nonEmpty = panes.filter((item) => item.tabIds.length > 0);
  const finalPanes = nonEmpty.length > 0 ? nonEmpty : panes.slice(0, 1);
  const activePaneId = finalPanes.some((item) => item.id === preferred)
    ? preferred
    : (finalPanes[0]?.id ?? FIRST_PANE);
  const active = finalPanes.find((item) => item.id === activePaneId);
  return {
    panes: finalPanes,
    activePaneId,
    activeId: active?.activeId ?? null,
    split: finalPanes.length > 1 ? (split ?? "row") : null,
  };
}

function withActiveTab(panes: WorkspacePane[], paneId: string, tabId: string): WorkspacePane[] {
  return panes.map((item) => (item.id === paneId ? { ...item, activeId: tabId } : item));
}

function addTabTo(panes: WorkspacePane[], paneId: string, tabId: string): WorkspacePane[] {
  return panes.map((item) =>
    item.id === paneId
      ? { ...item, tabIds: [...item.tabIds, tabId], activeId: tabId }
      : item,
  );
}

function insertAt(tabIds: string[], tabId: string, beforeTabId?: string | null): string[] {
  const without = tabIds.filter((id) => id !== tabId);
  if (!beforeTabId) {
    return [...without, tabId];
  }
  const index = without.indexOf(beforeTabId);
  if (index < 0) {
    return [...without, tabId];
  }
  return [...without.slice(0, index), tabId, ...without.slice(index)];
}

function dropTab(panes: WorkspacePane[], tabId: string): WorkspacePane[] {
  return panes.map((item) => {
    if (!item.tabIds.includes(tabId)) {
      return item;
    }
    const tabIds = item.tabIds.filter((id) => id !== tabId);
    return {
      ...item,
      tabIds,
      activeId: item.activeId === tabId ? (tabIds[tabIds.length - 1] ?? null) : item.activeId,
    };
  });
}

export const useWorkspace = create<WorkspaceStore>((set) => {
  const insert = (
    state: WorkspaceStore,
    tab: WorkspaceTab,
  ): Partial<WorkspaceStore> => {
    const existing = state.tabs.some((item) => item.id === tab.id);
    const tabs = existing
      ? state.tabs.map((item) => (item.id === tab.id ? tab : item))
      : [...state.tabs, tab];
    const placed = state.panes.some((item) => item.tabIds.includes(tab.id));
    const panes = placed
      ? withActiveTab(state.panes, state.activePaneId, tab.id)
      : addTabTo(state.panes, state.activePaneId, tab.id);
    return { tabs, ...settle(panes, state.activePaneId, state.split) };
  };

  return {
    tabs: [],
    panes: [pane(FIRST_PANE)],
    activePaneId: FIRST_PANE,
    activeId: null,
    split: null,

    openPage: (kind) => {
      const id = `page:${kind}`;
      set((state) =>
        insert(state, {
          id,
          kind,
          title: PAGE_TITLES[kind],
          hostId: null,
          pinned: false,
        }),
      );
    },

    openHost: (host) => {
      const id = `host:${host.id}`;
      set((state) =>
        insert(state, {
          id,
          kind: "host",
          title: host.name,
          hostId: host.id,
          pinned: false,
        }),
      );
    },

    openTerminal: (session) => {
      set((state) =>
        insert(state, {
          id: `terminal:${session.id}`,
          kind: "terminal",
          title: session.title,
          hostId: session.hostId,
          pinned: false,
        }),
      );
    },

    openSftp: (session) => {
      set((state) =>
        insert(state, {
          id: `sftp:${session.id}`,
          kind: "sftp",
          title: session.title,
          hostId: session.hostId,
          pinned: false,
        }),
      );
    },

    openEditor: (session, path) => {
      const id = `editor:${session.id}:${path}`;
      set((state) =>
        insert(state, {
          id,
          kind: "editor",
          title: fileName(path),
          hostId: session.hostId,
          pinned: false,
        }),
      );
      if (!useEditors.getState().entries[id]) {
        void useEditors.getState().open(id, session.id, path);
      }
    },

    openHistory: (session) => {
      set((state) =>
        insert(state, {
          id: `history:${session.id}`,
          kind: "history",
          title: session.title,
          hostId: session.hostId,
          pinned: false,
        }),
      );
    },

    openMonitor: (session) => {
      set((state) =>
        insert(state, {
          id: `monitor:${session.id}`,
          kind: "monitor",
          title: session.title,
          hostId: session.hostId,
          pinned: false,
        }),
      );
    },

    openPluginView: (pluginId, viewId, title) => {
      set((state) =>
        insert(state, {
          id: `plugin:${pluginId}:${viewId}`,
          kind: "pluginView",
          title,
          hostId: null,
          pinned: false,
        }),
      );
    },

    closeSession: (sessionId) => {
      const matches = (id: string) =>
        id === `terminal:${sessionId}` ||
        id === `sftp:${sessionId}` ||
        id === `history:${sessionId}` ||
        id === `monitor:${sessionId}` ||
        id.startsWith(`editor:${sessionId}:`);

      set((state) => {
        const removed = state.tabs.filter((tab) => matches(tab.id));
        if (removed.length === 0) {
          return state;
        }
        for (const tab of removed) {
          if (tab.kind === "editor") {
            useEditors.getState().discard(tab.id);
          }
        }
        const tabs = state.tabs.filter((tab) => !matches(tab.id));
        const panes = state.panes.map((item) => {
          const tabIds = item.tabIds.filter((id) => !matches(id));
          const activeId = item.activeId && matches(item.activeId) ? (tabIds[0] ?? null) : item.activeId;
          return { ...item, tabIds, activeId };
        });
        return { tabs, ...settle(panes, state.activePaneId, state.split) };
      });
    },

    close: (id) => {
      set((state) => {
        if (!state.tabs.some((tab) => tab.id === id)) {
          return state;
        }
        const tabs = state.tabs.filter((tab) => tab.id !== id);
        const panes = dropTab(state.panes, id);
        return { tabs, ...settle(panes, state.activePaneId, state.split) };
      });
    },

    closeOthers: (id) => {
      set((state) => {
        const origin = state.panes.find((item) => item.tabIds.includes(id));
        if (!origin) {
          return state;
        }
        const keep = new Set([id, ...origin.tabIds.filter((tabId) => state.tabs.find((tab) => tab.id === tabId)?.pinned)]);
        const tabs = state.tabs.filter((tab) => keep.has(tab.id));
        const panes = state.panes.map((item) =>
          item.id === origin.id
            ? { ...item, tabIds: item.tabIds.filter((tabId) => keep.has(tabId)), activeId: id }
            : { ...item, tabIds: item.tabIds.filter((tabId) => keep.has(tabId)) },
        );
        return { tabs, ...settle(panes, origin.id, state.split) };
      });
    },

    activate: (id) => {
      set((state) => {
        const target = state.panes.find((item) => item.tabIds.includes(id));
        if (!target) {
          return state;
        }
        return {
          panes: withActiveTab(state.panes, target.id, id),
          activePaneId: target.id,
          activeId: id,
        };
      });
    },

    activatePane: (paneId) => {
      set((state) => {
        const target = state.panes.find((item) => item.id === paneId);
        if (!target) {
          return state;
        }
        return {
          activePaneId: paneId,
          activeId: target.activeId ?? state.activeId,
        };
      });
    },

    togglePin: (id) =>
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
      })),

    reorder: (from, to) =>
      set((state) => {
        const origin = state.panes.find((item) => item.id === state.activePaneId);
        if (!origin || from === to || from < 0 || to < 0) {
          return state;
        }
        if (from >= origin.tabIds.length || to >= origin.tabIds.length) {
          return state;
        }
        const tabIds = [...origin.tabIds];
        const [moved] = tabIds.splice(from, 1);
        if (!moved) {
          return state;
        }
        tabIds.splice(to, 0, moved);
        return {
          panes: state.panes.map((item) => (item.id === origin.id ? { ...item, tabIds } : item)),
        };
      }),

    splitTab: (tabId, direction, position = "after") => {
      set((state) => {
        const source = state.panes.find((item) => item.tabIds.includes(tabId));
        if (!source) {
          return state;
        }

        if (state.panes.length > 1) {
          const target = state.panes.find((item) => item.id !== source.id);
          if (!target) {
            return state;
          }
          const panes = dropTab(state.panes, tabId).map((item) =>
            item.id === target.id
              ? { ...item, tabIds: [...item.tabIds, tabId], activeId: tabId }
              : item,
          );
          return settle(panes, target.id, direction);
        }

        if (source.tabIds.length <= 1) {
          return state;
        }
        const remaining = source.tabIds.filter((id) => id !== tabId);
        const kept: WorkspacePane = {
          ...source,
          tabIds: remaining,
          activeId:
            source.activeId === tabId ? (remaining[remaining.length - 1] ?? null) : source.activeId,
        };
        const created: WorkspacePane = {
          id: position === "before" ? LEADING_PANE : SECOND_PANE,
          tabIds: [tabId],
          activeId: tabId,
        };
        const panes = position === "before" ? [created, kept] : [kept, created];
        return { panes, activePaneId: created.id, activeId: tabId, split: direction };
      });
    },

    moveTab: (tabId, targetPaneId, beforeTabId) => {
      set((state) => {
        const source = state.panes.find((item) => item.tabIds.includes(tabId));
        const target = state.panes.find((item) => item.id === targetPaneId);
        if (!source || !target) {
          return state;
        }
        const panes = dropTab(state.panes, tabId).map((item) =>
          item.id === targetPaneId
            ? {
                ...item,
                tabIds: insertAt(item.tabIds, tabId, beforeTabId ?? null),
                activeId: tabId,
              }
            : item,
        );
        return { ...settle(panes, targetPaneId, state.split) };
      });
    },

    reorderTab: (tabId, beforeTabId) => {
      set((state) => {
        const origin = state.panes.find((item) => item.tabIds.includes(tabId));
        if (!origin || tabId === beforeTabId) {
          return state;
        }
        const tabIds = insertAt(origin.tabIds, tabId, beforeTabId);
        return {
          panes: state.panes.map((item) => (item.id === origin.id ? { ...item, tabIds } : item)),
        };
      });
    },

    closePane: (paneId) => {
      set((state) => {
        if (state.panes.length <= 1) {
          return state;
        }
        const closing = state.panes.find((item) => item.id === paneId);
        if (!closing) {
          return state;
        }
        const remaining = state.panes.filter((item) => item.id !== paneId);
        const target = remaining[0];
        if (!target) {
          return state;
        }
        const panes = remaining.map((item) =>
          item.id === target.id
            ? { ...item, tabIds: [...item.tabIds, ...closing.tabIds] }
            : item,
        );
        return { ...settle(panes, target.id, null), split: null };
      });
    },

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
      set({
        tabs,
        panes: [{ id: FIRST_PANE, tabIds: tabs.map((tab) => tab.id), activeId: tabs[0]?.id ?? null }],
        activePaneId: FIRST_PANE,
        activeId: tabs[0]?.id ?? null,
        split: null,
      });
    },

    removeHost: (hostId) => {
      const id = `host:${hostId}`;
      set((state) => {
        if (!state.tabs.some((tab) => tab.id === id)) {
          return state;
        }
        const tabs = state.tabs.filter((tab) => tab.id !== id);
        const panes = dropTab(state.panes, id);
        return { tabs, ...settle(panes, state.activePaneId, state.split) };
      });
    },

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
        return {
          tabs: [tab],
          panes: [{ id: FIRST_PANE, tabIds: [tab.id], activeId: tab.id }],
          activePaneId: FIRST_PANE,
          activeId: tab.id,
          split: null,
        };
      }),
  };
});

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
