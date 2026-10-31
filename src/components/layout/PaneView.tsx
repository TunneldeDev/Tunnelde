// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  Activity,
  Blocks,
  Home,
  Download,
  FileText,
  FolderTree,
  History,
  Info,
  Pin,
  Server,
  ShieldCheck,
  Settings as SettingsIcon,
  Terminal,
  X,
} from "lucide-react";
import type { ComponentType, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TabContent } from "@/components/layout/TabContent";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn } from "@/lib/text/format";
import { closeTab } from "@/lib/session/tabActions";
import { useContextMenu } from "@/store/contextMenu";
import { useSettings } from "@/store/settings";
import { useNavigation } from "@/store/navigation";
import { isTauri } from "@/lib/api/ipc";
import { useEditors } from "@/store/editors";
import {
  useWorkspace,
  type SplitDirection,
  type WorkspacePane,
  type WorkspaceTab,
  type WorkspaceLayout,
} from "@/store/workspace";

export const TAB_MIME = "application/x-tunnelde-tab";

function topCornerPane(layout: WorkspaceLayout, side: "left" | "right"): string {
  if (layout.kind === "pane") return layout.paneId;
  return topCornerPane(
    layout.direction === "column" || side === "left" ? layout.first : layout.second,
    side,
  );
}

const ICONS: Record<WorkspaceTab["kind"], ComponentType<{ size?: number }>> = {
  welcome: Home,
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
  knownHosts: ShieldCheck,
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
  knownHosts: "nav.knownHosts",
} as const;

function TabLabel({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const dirty = useEditors((state) => {
    const entry = state.entries[tab.id];
    return !!entry && !entry.loading && entry.content !== entry.baseline;
  });
  if (NAMED.includes(tab.kind)) {
    return (
      <>
        {tab.title}
        {dirty ? " •" : ""}
      </>
    );
  }
  return <>{t(NAV_KEYS[tab.kind as keyof typeof NAV_KEYS])}</>;
}

function TabStrip({ pane }: { pane: WorkspacePane }) {
  const { t } = useTranslation();
  const tabs = useWorkspace((state) => state.tabs);
  const activate = useWorkspace((state) => state.activate);
  const togglePin = useWorkspace((state) => state.togglePin);
  const reorderTab = useWorkspace((state) => state.reorderTab);
  const moveTab = useWorkspace((state) => state.moveTab);
  const closeOthers = useWorkspace((state) => state.closeOthers);
  const splitTab = useWorkspace((state) => state.splitTab);
  const panes = useWorkspace((state) => state.panes);
  const openMenu = useContextMenu((state) => state.open);
  const closePane = useWorkspace((state) => state.closePane);
  const paneCount = panes.length;
  const layout = useWorkspace((state) => state.layout);
  const compact = useSettings((state) => state.settings.titleBarStyle === "compact");
  const panelOpen = useSettings((state) => state.settings.rightPanel);
  const mac = useSettings((state) => state.info?.os === "macos");
  const sidebarOpen = useNavigation((state) => state.sidebarVisible);
  const reserveControls =
    isTauri() && compact && !mac && !panelOpen && topCornerPane(layout, "right") === pane.id;
  const reserveTrafficLights =
    isTauri() && compact && mac && !sidebarOpen && topCornerPane(layout, "left") === pane.id;
  const [before, setBefore] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pane.activeId]);

  const items = pane.tabIds
    .map((id) => tabs.find((tab) => tab.id === id))
    .filter((tab): tab is WorkspaceTab => Boolean(tab));

  const requestClose = (tab: WorkspaceTab) => closeTab(tab);

  const dropIndex = (event: DragEvent<HTMLDivElement>): string | null => {
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-tab-id]"));
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
      ref={strip}
      className={cn(
        "pane__tabs",
        reserveControls && "has-window-controls",
        reserveTrafficLights && "has-native-window-controls",
      )}
      role="tablist"

      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_MIME)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left + 36) event.currentTarget.scrollLeft -= 18;
        if (event.clientX > rect.right - 36) event.currentTarget.scrollLeft += 18;
        setBefore(dropIndex(event));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBefore(null);
      }}
      onDrop={(event) => {
        const tabId = event.dataTransfer.getData(TAB_MIME);
        const target = dropIndex(event);
        setBefore(null);
        if (!tabId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
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
            title={
              NAMED.includes(tab.kind) ? tab.title : t(NAV_KEYS[tab.kind as keyof typeof NAV_KEYS])
            }
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
                event.preventDefault();
                requestClose(tab);
              }
            }}
            onDoubleClick={() => togglePin(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const items = [
                { label: t("tab.close"), onSelect: () => requestClose(tab) },
                { label: t("tab.closeOthers"), onSelect: () => closeOthers(tab.id) },
                { label: t("tab.splitRight"), onSelect: () => splitTab(tab.id, "row") },
                { label: t("tab.splitDown"), onSelect: () => splitTab(tab.id, "column") },
              ];
              if (panes.length > 1) {
                items.push({
                  label: t("tab.closePane"),
                  onSelect: () => useWorkspace.getState().closePane(pane.id),
                });
              }
              openMenu(event.clientX, event.clientY, items);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const index = items.findIndex((item) => item.id === tab.id);
              const destination =
                event.key === "ArrowLeft"
                  ? items[(index - 1 + items.length) % items.length]
                  : event.key === "ArrowRight"
                    ? items[(index + 1) % items.length]
                    : event.key === "Home"
                      ? items[0]
                      : event.key === "End"
                        ? items[items.length - 1]
                        : undefined;
              if (destination) {
                event.preventDefault();
                activate(destination.id);
                const element = Array.from(
                  strip.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
                ).find((item) => item.dataset.tabId === destination.id);
                element?.focus();
                return;
              }
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
              title={t("tab.close")}
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
      {paneCount > 1 ? (
        <button
          type="button"
          className="pane__tabs-close"
          aria-label={t("tab.closePane")}
          title={t("tab.closePane")}
          onClick={() => closePane(pane.id)}
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

type DropHint = "left" | "right" | "top" | "bottom";

function zoneOf(
  element: HTMLDivElement,
  event: { clientX: number; clientY: number },
): DropHint | null {
  const rect = element.getBoundingClientRect();
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
  const body = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((tab) => tab.id === pane.activeId) ?? null;

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const over = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes(TAB_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setHint(zoneOf(element, event));
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget))
        setHint(null);
    };
    const drop = (event: globalThis.DragEvent) => {
      const tabId = event.dataTransfer?.getData(TAB_MIME);
      if (!tabId) return;
      event.preventDefault();
      event.stopPropagation();
      setHint(null);
      const zone = zoneOf(element, event);
      if (!zone) {
        moveTab(tabId, pane.id);
        return;
      }
      const direction: SplitDirection = zone === "left" || zone === "right" ? "row" : "column";
      splitTab(tabId, direction, zone === "left" || zone === "top" ? "before" : "after", pane.id);
    };
    // Page contents live in stable portals; native listeners follow their actual
    // group rather than the React tree that owns their component instance.
    element.addEventListener("dragover", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
    };
  }, [pane.id, moveTab, splitTab]);

  return (
    <section
      className={cn("pane", active && "is-active")}
      onMouseDown={() => activatePane(pane.id)}
      onFocusCapture={() => activatePane(pane.id)}
    >
      <TabStrip pane={pane} />
      <div ref={body} className="pane__body">
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
