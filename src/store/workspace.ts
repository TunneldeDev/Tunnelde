// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { api } from "@/lib/api/ipc";
import type { Host, SshSession, TabKind, TabRecord } from "@/lib/api/types";
import { fileName, useEditors } from "@/store/editors";
import { useDialogs } from "@/store/dialogs";
import i18n from "@/i18n/i18n";

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
export type WorkspaceLayout =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: WorkspaceLayout;
      second: WorkspaceLayout;
    };
/** Where a dragged tab lands relative to the tabs that stay behind. */
export type PanePosition = "before" | "after";

export type PageKind = "welcome" | "settings" | "about" | "updates" | "knownHosts";

const PAGE_TITLES: Record<PageKind, string> = {
  welcome: "welcome",
  settings: "settings",
  about: "about",
  updates: "updates",
  knownHosts: "knownHosts",
};

const SUPPORTED_KINDS: TabKind[] = [
  "welcome",
  "host",
  "settings",
  "about",
  "updates",
  "knownHosts",
];

export const FIRST_PANE = "pane-1";

interface WorkspaceStore {
  tabs: WorkspaceTab[];
  panes: WorkspacePane[];
  activePaneId: string;
  activeId: string | null;
  split: SplitDirection | null;
  layout: WorkspaceLayout;
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
  splitTab: (
    tabId: string,
    direction: SplitDirection,
    position?: PanePosition,
    targetPaneId?: string,
  ) => void;
  resizeSplit: (id: string, ratio: number) => void;
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
  layout: WorkspaceLayout;
}

const pane = (id: string): WorkspacePane => ({ id, tabIds: [], activeId: null });

function settle(
  panes: WorkspacePane[],
  preferred: string,
  split: SplitDirection | null,
  layout?: WorkspaceLayout,
): PanesState {
  const nonEmpty = panes.filter((item) => item.tabIds.length > 0);
  const finalPanes = (nonEmpty.length > 0 ? nonEmpty : panes.slice(0, 1)).map((item) => ({
    ...item,
    activeId:
      item.activeId && item.tabIds.includes(item.activeId)
        ? item.activeId
        : (item.tabIds[0] ?? null),
  }));
  const pruned = pruneLayout(layout, new Set(finalPanes.map((item) => item.id)));
  const normalizedLayout =
    pruned && finalPanes.every((item) => layoutPanes(pruned).includes(item.id))
      ? pruned
      : linearLayout(finalPanes, split ?? "row");
  const order = layoutPanes(normalizedLayout);
  finalPanes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const activePaneId = finalPanes.some((item) => item.id === preferred)
    ? preferred
    : (finalPanes[0]?.id ?? FIRST_PANE);
  const active = finalPanes.find((item) => item.id === activePaneId);
  return {
    panes: finalPanes,
    activePaneId,
    activeId: active?.activeId ?? null,
    split: normalizedLayout.kind === "split" ? normalizedLayout.direction : null,
    layout: normalizedLayout,
  };
}

function layoutPanes(layout: WorkspaceLayout): string[] {
  return layout.kind === "pane"
    ? [layout.paneId]
    : [...layoutPanes(layout.first), ...layoutPanes(layout.second)];
}

function pruneLayout(
  layout: WorkspaceLayout | undefined,
  valid: Set<string>,
): WorkspaceLayout | null {
  if (!layout) return null;
  if (layout.kind === "pane") return valid.has(layout.paneId) ? layout : null;
  const first = pruneLayout(layout.first, valid);
  const second = pruneLayout(layout.second, valid);
  return first && second ? { ...layout, first, second } : (first ?? second);
}

function linearLayout(panes: WorkspacePane[], direction: SplitDirection): WorkspaceLayout {
  const [first, ...rest] = panes;
  const leaf: WorkspaceLayout = { kind: "pane", paneId: first?.id ?? FIRST_PANE };
  return rest.length
    ? {
        kind: "split",
        id: crypto.randomUUID(),
        direction,
        ratio: 0.5,
        first: leaf,
        second: linearLayout(rest, direction),
      }
    : leaf;
}

function mapLayout(
  layout: WorkspaceLayout,
  transform: (node: WorkspaceLayout) => WorkspaceLayout,
): WorkspaceLayout {
  const mapped =
    layout.kind === "split"
      ? {
          ...layout,
          first: mapLayout(layout.first, transform),
          second: mapLayout(layout.second, transform),
        }
      : layout;
  return transform(mapped);
}

function readLayout(value: unknown, depth = 0): WorkspaceLayout | null {
  if (!value || typeof value !== "object" || depth > 20) return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane" && typeof node.paneId === "string")
    return { kind: "pane", paneId: node.paneId };
  if (
    node.kind !== "split" ||
    typeof node.id !== "string" ||
    (node.direction !== "row" && node.direction !== "column")
  )
    return null;
  const first = readLayout(node.first, depth + 1);
  const second = readLayout(node.second, depth + 1);
  if (!first || !second || typeof node.ratio !== "number" || !Number.isFinite(node.ratio))
    return null;
  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: Math.max(0.15, Math.min(0.85, node.ratio)),
    first,
    second,
  };
}

function withActiveTab(panes: WorkspacePane[], paneId: string, tabId: string): WorkspacePane[] {
  return panes.map((item) => (item.id === paneId ? { ...item, activeId: tabId } : item));
}

function addTabTo(panes: WorkspacePane[], paneId: string, tabId: string): WorkspacePane[] {
  return panes.map((item) =>
    item.id === paneId ? { ...item, tabIds: [...item.tabIds, tabId], activeId: tabId } : item,
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
    const index = item.tabIds.indexOf(tabId);
    return {
      ...item,
      tabIds,
      activeId:
        item.activeId === tabId
          ? (tabIds[Math.min(index, tabIds.length - 1)] ?? null)
          : item.activeId,
    };
  });
}

export const useWorkspace = create<WorkspaceStore>((set) => {
  const insert = (state: WorkspaceStore, tab: WorkspaceTab): Partial<WorkspaceStore> => {
    const existing = state.tabs.find((item) => item.id === tab.id);
    const tabs = existing
      ? state.tabs.map((item) => (item.id === tab.id ? { ...tab, pinned: item.pinned } : item))
      : [...state.tabs, tab];
    const placed = state.panes.find((item) => item.tabIds.includes(tab.id));
    const ownerId = placed?.id ?? state.activePaneId;
    const panes = placed
      ? withActiveTab(state.panes, ownerId, tab.id)
      : addTabTo(state.panes, state.activePaneId, tab.id);
    return { tabs, ...settle(panes, ownerId, state.split, state.layout) };
  };

  return {
    tabs: [],
    panes: [pane(FIRST_PANE)],
    activePaneId: FIRST_PANE,
    activeId: null,
    split: null,
    layout: { kind: "pane", paneId: FIRST_PANE },

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
      const editors = useEditors.getState();
      const matches = (id: string) =>
        id.startsWith("editor:")
          ? editors.entries[id]
            ? editors.entries[id]?.sessionId === sessionId
            : id.startsWith(`editor:${sessionId}:`)
          : id === `terminal:${sessionId}` ||
            id === `sftp:${sessionId}` ||
            id === `history:${sessionId}` ||
            id === `monitor:${sessionId}`;

      editors.markDisconnected(sessionId);

      set((state) => {
        const removed = state.tabs.filter(
          (tab) => matches(tab.id) && !(tab.kind === "editor" && editors.isDirty(tab.id)),
        );
        if (removed.length === 0) {
          return state;
        }
        for (const tab of removed) {
          if (tab.kind === "editor") {
            useEditors.getState().discard(tab.id);
          }
        }
        const removedIds = new Set(removed.map((tab) => tab.id));
        const tabs = state.tabs.filter((tab) => !removedIds.has(tab.id));
        const panes = state.panes.map((item) => {
          const tabIds = item.tabIds.filter((id) => !removedIds.has(id));
          const activeId =
            item.activeId && removedIds.has(item.activeId) ? (tabIds[0] ?? null) : item.activeId;
          return { ...item, tabIds, activeId };
        });
        return { tabs, ...settle(panes, state.activePaneId, state.split, state.layout) };
      });
    },

    close: (id) => {
      set((state) => {
        if (!state.tabs.some((tab) => tab.id === id)) {
          return state;
        }
        const tabs = state.tabs.filter((tab) => tab.id !== id);
        const panes = dropTab(state.panes, id);
        return { tabs, ...settle(panes, state.activePaneId, state.split, state.layout) };
      });
    },

    closeOthers: (id) => {
      const state = useWorkspace.getState();
      const origin = state.panes.find((item) => item.tabIds.includes(id));
      if (!origin) return;
      const removed = state.tabs.filter(
        (tab) => origin.tabIds.includes(tab.id) && tab.id !== id && !tab.pinned,
      );
      const commit = () => {
        const removedIds = new Set(removed.map((tab) => tab.id));
        for (const tab of removed) if (tab.kind === "editor") useEditors.getState().discard(tab.id);
        set((current) => {
          const tabs = current.tabs.filter((tab) => !removedIds.has(tab.id));
          const panes = current.panes.map((item) =>
            item.id === origin.id
              ? {
                  ...item,
                  tabIds: item.tabIds.filter((tabId) => !removedIds.has(tabId)),
                  activeId: id,
                }
              : item,
          );
          return { tabs, ...settle(panes, origin.id, current.split, current.layout) };
        });
      };
      const dirty = removed.filter(
        (tab) => tab.kind === "editor" && useEditors.getState().isDirty(tab.id),
      );
      if (!dirty.length) {
        commit();
        return;
      }
      useDialogs.getState().confirm({
        title: i18n.t("editor.discardTitle"),
        body: i18n.t("editor.discardBody", { name: dirty.map((tab) => tab.title).join(", ") }),
        confirmLabel: i18n.t("editor.discard"),
        danger: true,
        onConfirm: commit,
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
          activeId: target.activeId,
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

    splitTab: (tabId, direction, position = "after", targetPaneId) => {
      set((state) => {
        const source = state.panes.find((item) => item.tabIds.includes(tabId));
        const target = state.panes.find((item) => item.id === (targetPaneId ?? source?.id));
        if (!source || (targetPaneId !== "root" && !target)) return state;
        if (source.tabIds.length <= 1 && (state.panes.length === 1 || source.id === target?.id))
          return state;
        const created: WorkspacePane = {
          id: `pane-${crypto.randomUUID()}`,
          tabIds: [tabId],
          activeId: tabId,
        };
        const panes = [...dropTab(state.panes, tabId), created];
        let layout =
          pruneLayout(state.layout, new Set(state.panes.map((item) => item.id))) ??
          linearLayout(state.panes, state.split ?? "row");
        const wrap = (node: WorkspaceLayout): WorkspaceLayout => ({
          kind: "split",
          id: crypto.randomUUID(),
          direction,
          ratio: 0.5,
          first: position === "before" ? { kind: "pane", paneId: created.id } : node,
          second: position === "before" ? node : { kind: "pane", paneId: created.id },
        });
        layout =
          targetPaneId === "root"
            ? wrap(layout)
            : mapLayout(layout, (node) =>
                node.kind === "pane" && node.paneId === target?.id ? wrap(node) : node,
              );
        return settle(panes, created.id, direction, layout);
      });
    },

    resizeSplit: (id, ratio) => {
      if (!Number.isFinite(ratio)) return;
      set((state) => ({
        layout: mapLayout(state.layout, (node) =>
          node.kind === "split" && node.id === id
            ? { ...node, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
            : node,
        ),
      }));
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
        return { ...settle(panes, targetPaneId, state.split, state.layout) };
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
        const index = state.panes.findIndex((item) => item.id === paneId);
        const target = state.panes[index - 1] ?? state.panes[index + 1];
        if (!target) {
          return state;
        }
        const panes = remaining.map((item) =>
          item.id === target.id ? { ...item, tabIds: [...item.tabIds, ...closing.tabIds] } : item,
        );
        return settle(panes, target.id, state.split, state.layout);
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
        if (tabs.some((tab) => tab.id === record.id)) continue;
        tabs.push({
          id: record.id,
          kind: record.kind,
          title: record.title,
          hostId: record.hostId,
          pinned: record.pinned,
        });
      }
      let restored: PanesState | undefined;
      try {
        const metadata = records.find((record) => record.state)?.state;
        const snapshot = metadata
          ? (JSON.parse(metadata) as {
              version?: unknown;
              layout?: unknown;
              panes?: WorkspacePane[];
              activePaneId?: string;
            })
          : null;
        const layout = readLayout(snapshot?.layout);
        if (snapshot?.version === 1 && layout && Array.isArray(snapshot.panes)) {
          const seen = new Set<string>();
          const paneIds = new Set<string>();
          const valid = new Set(tabs.map((tab) => tab.id));
          const panes: WorkspacePane[] = [];
          for (const item of snapshot.panes) {
            if (
              !item ||
              typeof item.id !== "string" ||
              paneIds.has(item.id) ||
              !Array.isArray(item.tabIds)
            )
              continue;
            paneIds.add(item.id);
            const tabIds = item.tabIds.filter((id) => {
              if (typeof id !== "string" || seen.has(id) || !valid.has(id)) return false;
              seen.add(id);
              return true;
            });
            panes.push({
              id: item.id,
              tabIds,
              activeId: tabIds.includes(item.activeId ?? "") ? item.activeId : (tabIds[0] ?? null),
            });
          }
          if (panes.length) {
            panes[0]!.tabIds.push(...tabs.filter((tab) => !seen.has(tab.id)).map((tab) => tab.id));
            const layoutIds = layoutPanes(layout);
            if (
              new Set(layoutIds).size === layoutIds.length &&
              panes.every((item) => layoutIds.includes(item.id))
            ) {
              restored = settle(panes, snapshot.activePaneId ?? panes[0]!.id, null, layout);
            }
          }
        }
      } catch {
        /* Older tabs did not store a layout. */
      }
      set({
        tabs,
        panes: [
          { id: FIRST_PANE, tabIds: tabs.map((tab) => tab.id), activeId: tabs[0]?.id ?? null },
        ],
        activePaneId: FIRST_PANE,
        activeId: tabs[0]?.id ?? null,
        split: null,
        layout: { kind: "pane", paneId: FIRST_PANE },
        ...restored,
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
        return { tabs, ...settle(panes, state.activePaneId, state.split, state.layout) };
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
          layout: { kind: "pane", paneId: FIRST_PANE },
        };
      }),
  };
});

export function persistWorkspace(): void {
  void api.saveTabs(workspaceRecords()).catch(() => undefined);
}

export function workspaceRecords(): TabRecord[] {
  const { tabs, panes, layout, activePaneId } = useWorkspace.getState();
  const ordered = panes
    .flatMap((item) => item.tabIds)
    .map((id) => tabs.find((tab) => tab.id === id))
    .filter((tab): tab is WorkspaceTab => !!tab);
  const snapshot = JSON.stringify({ version: 1, panes, layout, activePaneId });
  return ordered.map((tab, index) => ({
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    hostId: tab.hostId,
    sortOrder: index,
    pinned: tab.pinned,
    state: index === 0 ? snapshot : null,
  }));
}
