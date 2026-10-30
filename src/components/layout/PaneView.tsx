// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  Activity,
  Blocks,
  CircleDot,
  Download,
  FileText,
  FolderTree,
  History,
  Info,
  Pin,
  Server,
  Settings as SettingsIcon,
  Terminal,
  X,
} from "lucide-react";
import type { ComponentType, DragEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { TabContent } from "@/components/layout/TabContent";
import { EmptyState } from "@/components/ui/Misc";
import { cn } from "@/lib/format";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import {
  useWorkspace,
  type SplitDirection,
  type WorkspacePane,
  type WorkspaceTab,
} from "@/store/workspace";

const TAB_MIME = "application/x-tunnelde-tab";

const ICONS: Record<WorkspaceTab["kind"], ComponentType<{ size?: number }>> = {
  welcome: CircleDot,
  host: Server,
  settings: SettingsIcon,
  about: Info,
  updates: Download,
  terminal: Terminal,
  sftp: FolderTree,
  editor: FileText,
  history: History,
  monitor: Activity,
  pluginView: Blocks,
};

const NAMED: WorkspaceTab["kind"][] = [
  "host",
  "terminal",
  "sftp",
  "editor",
  "history",
  "monitor",
  "pluginView",
];

const NAV_KEYS = {
  welcome: "nav.welcome",
  settings: "nav.settings",
  about: "nav.about",
  updates: "nav.updates",
} as const;

function TabLabel({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  if (NAMED.includes(tab.kind)) {
    return <>{tab.title}</>;
  }
  return <>{t(NAV_KEYS[tab.kind as keyof typeof NAV_KEYS])}</>;
}

function TabStrip({ pane }: { pane: WorkspacePane }) {
  const { t } = useTranslation();
  const tabs = useWorkspace((state) => state.tabs);
  const activate = useWorkspace((state) => state.activate);
  const close = useWorkspace((state) => state.close);
  const togglePin = useWorkspace((state) => state.togglePin);
  const reorderTab = useWorkspace((state) => state.reorderTab);
  const moveTab = useWorkspace((state) => state.moveTab);
  const confirm = useDialogs((state) => state.confirm);
  const [before, setBefore] = useState<string | null>(null);

  const items = pane.tabIds
    .map((id) => tabs.find((tab) => tab.id === id))
    .filter((tab): tab is WorkspaceTab => Boolean(tab));

  const requestClose = (tab: WorkspaceTab) => {
    if (tab.kind === "editor" && useEditors.getState().isDirty(tab.id)) {
      confirm({
        title: t("editor.discardTitle"),
        body: t("editor.discardBody", { name: tab.title }),
        confirmLabel: t("editor.discard"),
        danger: true,
        onConfirm: () => {
          useEditors.getState().discard(tab.id);
          close(tab.id);
        },
      });
      return;
    }
    if (tab.kind === "editor") {
      useEditors.getState().discard(tab.id);
    }
    close(tab.id);
  };

  const dropIndex = (event: DragEvent<HTMLDivElement>): string | null => {
    const elements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        return element.dataset.tabId ?? null;
      }
    }
    return null;
  };

  return (
    <div
      className="pane__tabs"
      role="tablist"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_MIME)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setBefore(dropIndex(event));
      }}
      onDragLeave={() => setBefore(null)}
      onDrop={(event) => {
        const tabId = event.dataTransfer.getData(TAB_MIME);
        const target = dropIndex(event);
        setBefore(null);
        if (!tabId) {
          return;
        }
        event.preventDefault();
        if (pane.tabIds.includes(tabId)) {
          reorderTab(tabId, target);
        } else {
          moveTab(tabId, pane.id, target);
        }
      }}
    >
      {items.map((tab) => {
        const Icon = ICONS[tab.kind];
        const active = tab.id === pane.activeId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            draggable
            className={cn(
              "td-tab",
              active && "is-active",
              tab.pinned && "is-pinned",
              before === tab.id && "is-drop-before",
            )}
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_MIME, tab.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => activate(tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                requestClose(tab);
              }
            }}
            onDoubleClick={() => togglePin(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate(tab.id);
              }
            }}
          >
            {tab.pinned ? <Pin size={11} className="td-tab__pin" /> : <Icon size={13} />}
            <span className="td-tab__label">
              <TabLabel tab={tab} />
            </span>
            <button
              type="button"
              className="td-tab__close"
              aria-label={t("tab.close")}
              onClick={(event) => {
                event.stopPropagation();
                requestClose(tab);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

type DropHint = "left" | "right" | "top" | "bottom";

function zoneOf(event: DragEvent<HTMLDivElement>): DropHint | null {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (x < 0.25) {
    return "left";
  }
  if (x > 0.75) {
    return "right";
  }
  if (y < 0.2) {
    return "top";
  }
  if (y > 0.8) {
    return "bottom";
  }
  return null;
}

export function PaneView({ pane, active }: { pane: WorkspacePane; active: boolean }) {
  const tabs = useWorkspace((state) => state.tabs);
  const activatePane = useWorkspace((state) => state.activatePane);
  const moveTab = useWorkspace((state) => state.moveTab);
  const splitTab = useWorkspace((state) => state.splitTab);
  const [hint, setHint] = useState<DropHint | null>(null);

  const activeTab = tabs.find((tab) => tab.id === pane.activeId) ?? null;

  const split = (tabId: string, hintValue: DropHint) => {
    const direction: SplitDirection =
      hintValue === "left" || hintValue === "right" ? "row" : "column";
    splitTab(tabId, direction);
  };

  return (
    <section
      className={cn("pane", active && "is-active")}
      onMouseDown={() => activatePane(pane.id)}
    >
      <TabStrip pane={pane} />
      <div
        className="pane__body"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(TAB_MIME)) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setHint(zoneOf(event));
        }}
        onDragLeave={() => setHint(null)}
        onDrop={(event) => {
          const tabId = event.dataTransfer.getData(TAB_MIME);
          const zone = hint;
          setHint(null);
          if (!tabId) {
            return;
          }
          event.preventDefault();
          if (zone) {
            split(tabId, zone);
          } else {
            moveTab(tabId, pane.id);
          }
        }}
      >
        {activeTab ? (
          <TabContent paneId={pane.id} />
        ) : (
          <div className="page">
            <EmptyState title="—" />
          </div>
        )}
        {hint ? <div className={cn("pane__drop", `is-${hint}`)} aria-hidden="true" /> : null}
      </div>
    </section>
  );
}
