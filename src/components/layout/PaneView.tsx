import {
  Activity,
  Blocks,
  Home,
  Download,
  FileText,
  FolderTree,
  History,
  Info,
  LockKeyhole,
  LockKeyholeOpen,
  PanelLeft,
  Server,
  ShieldCheck,
  Settings as SettingsIcon,
  Columns2,
  Terminal,
  X,
} from "lucide-react";
import type { ComponentType, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TabContent } from "@/components/layout/TabContent";
import { TabBarContributions } from "./TabBarContributions";
import { EmptyState } from "@/components/ui/display/Misc";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import { IconButton } from "@/components/ui/form/Button";
import { Menu } from "@/components/ui/overlay/Menu";
import { sidebarMoveActions } from "@/components/layout/SidebarDockControls";
import { cn } from "@/lib/text/format";
import { closeTab } from "@/lib/session/tabActions";
import { useContextMenu } from "@/store/contextMenu";
import { useSettings } from "@/store/settings";
import { useNavigation } from "@/store/navigation";
import { isTauri } from "@/lib/api/ipc";
import { useEditors } from "@/store/editors";
import { FILE_PANE_MIME, filePaneDrag } from "@/lib/session/filePaneDrag";
import {
  sidebarLabel,
  SIDEBAR_MIME,
  sidebarTabId,
  sidebarViewOf,
  TAB_MIME,
} from "@/lib/session/sidebarDock";
import {
  useWorkspace,
  visibleWorkspaceLayout,
  type SplitDirection,
  type WorkspacePane,
  type WorkspaceTab,
  type WorkspaceLayout,
} from "@/store/workspace";

export { TAB_MIME } from "@/lib/session/sidebarDock";

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
  pluginDetail: Blocks,
  knownHosts: ShieldCheck,
  sidebar: PanelLeft,
};

const NAMED: WorkspaceTab["kind"][] = [
  "host",
  "terminal",
  "sftp",
  "editor",
  "history",
  "monitor",
  "pluginView",
  "pluginDetail",
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
  const sidebar = tab.kind === "sidebar" ? sidebarViewOf(tab.id) : null;
  if (sidebar) return <>{sidebarLabel(sidebar, t)}</>;
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
  const resolveFileIcon = useFileIconResolver();
  const { t } = useTranslation();
  const tabs = useWorkspace((state) => state.tabs);
  const activate = useWorkspace((state) => state.activate);
  const togglePin = useWorkspace((state) => state.togglePin);
  const keepTab = useWorkspace((state) => state.keepTab);
  const reorderTab = useWorkspace((state) => state.reorderTab);
  const moveTab = useWorkspace((state) => state.moveTab);
  const closeOthers = useWorkspace((state) => state.closeOthers);
  const splitTab = useWorkspace((state) => state.splitTab);
  const panes = useWorkspace((state) => state.panes);
  const openMenu = useContextMenu((state) => state.open);
  const closePane = useWorkspace((state) => state.closePane);
  const togglePaneLock = useWorkspace((state) => state.togglePaneLock);
  const paneCount = panes.length;
  const storedLayout = useWorkspace((state) => state.layout);
  const layout = visibleWorkspaceLayout(storedLayout, panes, tabs);
  const compact = useSettings((state) => state.settings.titleBarStyle === "compact");
  const panelOpen = useSettings((state) => state.settings.rightPanel);
  const mac = useSettings((state) => state.info?.os === "macos");
  const sidebarRequested = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const sidebarOpen =
    sidebarRequested && !tabs.some((tab) => tab.id === sidebarTabId(activeSidebar));
  const reserveControls =
    isTauri() && compact && !mac && !panelOpen && topCornerPane(layout, "right") === pane.id;
  const reserveTrafficLights =
    isTauri() && compact && mac && !sidebarOpen && topCornerPane(layout, "left") === pane.id;
  const [before, setBefore] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () =>
      element
        .querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [pane.activeId]);

  const items = pane.tabIds
    .map((id) => tabs.find((tab) => tab.id === id))
    .filter((tab): tab is WorkspaceTab => Boolean(tab && !tab.hidden));
  const tabTitle = (tab: WorkspaceTab) =>
    tab.kind === "sidebar"
      ? sidebarLabel(sidebarViewOf(tab.id) ?? "hosts", t)
      : NAMED.includes(tab.kind)
        ? tab.title
        : t(NAV_KEYS[tab.kind as keyof typeof NAV_KEYS]);

  const requestClose = (tab: WorkspaceTab) => closeTab(tab);
  const activeTab = items.find((tab) => tab.id === pane.activeId);
  const activeSidebarView = activeTab?.kind === "sidebar" ? sidebarViewOf(activeTab.id) : null;
  const focusActiveTab = () => {
    requestAnimationFrame(() => {
      const activeId = useWorkspace.getState().activeId;
      Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]"))
        .find((element) => element.dataset.tabId === activeId)
        ?.focus({ preventScroll: true });
    });
  };
  const splitActive = (direction: SplitDirection) => {
    if (!activeTab || items.length < 2) return;
    splitTab(activeTab.id, direction);
    focusActiveTab();
  };
  const closeGroup = () => {
    closePane(pane.id);
    focusActiveTab();
  };

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
      className={cn(
        "pane__header",
        reserveControls && "has-window-controls",
        reserveTrafficLights && "has-native-window-controls",
      )}
    >
      <div
        ref={strip}
        className="pane__tabs"
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
              title={tab.preview ? `${tabTitle(tab)} · ${t("tab.previewHint")}` : tabTitle(tab)}
              tabIndex={active ? 0 : -1}
              draggable
              className={cn(
                "td-tab",
                active && "is-active",
                tab.pinned && "is-pinned",
                tab.preview && "is-preview",
                before === tab.id && "is-drop-before",
              )}
              onDragStart={(event) => {
                keepTab(tab.id);
                event.dataTransfer.setData(TAB_MIME, tab.id);
                const sidebar = tab.kind === "sidebar" ? sidebarViewOf(tab.id) : null;
                if (sidebar) event.dataTransfer.setData(SIDEBAR_MIME, sidebar);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => {
                if (active && tab.preview) keepTab(tab.id);
                activate(tab.id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  requestClose(tab);
                }
              }}
              onDoubleClick={(event) => {
                if (event.target instanceof Element && event.target.closest("button")) return;
                keepTab(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const items = [
                  {
                    label: t("tab.keepOpen"),
                    disabled: !tab.preview,
                    onSelect: () => keepTab(tab.id),
                  },
                  {
                    label: t(tab.pinned ? "tab.unpin" : "tab.pin"),
                    onSelect: () => togglePin(tab.id),
                  },
                  { label: t("tab.close"), onSelect: () => requestClose(tab) },
                  { label: t("tab.closeOthers"), onSelect: () => closeOthers(tab.id) },
                  {
                    label: t("tab.splitRight"),
                    separatorBefore: true,
                    onSelect: () => splitTab(tab.id, "row"),
                  },
                  { label: t("tab.splitDown"), onSelect: () => splitTab(tab.id, "column") },
                ];
                const sidebar = tab.kind === "sidebar" ? sidebarViewOf(tab.id) : null;
                if (sidebar)
                  items.push({
                    label: t("docking.returnToSidebar"),
                    separatorBefore: true,
                    onSelect: () => useWorkspace.getState().returnSidebar(sidebar),
                  });
                if (panes.length > 1) {
                  items.push({
                    label: t("tab.closePane"),
                    separatorBefore: true,
                    onSelect: closeGroup,
                  });
                }
                openMenu(event.clientX, event.clientY, items, event.currentTarget);
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
                  if (event.key === "Enter") keepTab(tab.id);
                }
              }}
            >
              {tab.kind === "editor" ? (
                <FileTypeIcon icon={resolveFileIcon(tab.title)} size={16} />
              ) : (
                <Icon size={13} />
              )}
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
      </div>
      {activeTab ? (
        <TabBarContributions
          context={{ tabId: activeTab.id, tabKind: activeTab.kind, paneId: pane.id }}
        />
      ) : null}
      <div className="pane__actions">
        <IconButton
          label={t(pane.locked ? "tab.unlockPane" : "tab.lockPane")}
          size="sm"
          className={pane.locked ? "is-locked" : undefined}
          aria-pressed={!!pane.locked}
          onClick={() => togglePaneLock(pane.id)}
        >
          {pane.locked ? <LockKeyhole size={13} /> : <LockKeyholeOpen size={13} />}
        </IconButton>
        {items.length > 1 ? (
          <IconButton
            label={t("tab.splitRight")}
            size="sm"
            className="pane__split"
            onClick={() => splitActive("row")}
          >
            <Columns2 size={14} />
          </IconButton>
        ) : null}
        <Menu
          label={t("common.more")}
          items={[
            ...(items.length > 1
              ? items.map((tab) => ({
                  label: tabTitle(tab),
                  checked: tab.id === pane.activeId,
                  onSelect: () => activate(tab.id),
                }))
              : []),
            {
              label: t("tab.close"),
              separatorBefore: items.length > 1,
              disabled: !activeTab,
              onSelect: () => {
                if (activeTab) requestClose(activeTab);
              },
            },
            {
              label: t("tab.splitRight"),
              separatorBefore: true,
              disabled: items.length < 2,
              onSelect: () => splitActive("row"),
            },
            {
              label: t("tab.splitDown"),
              disabled: items.length < 2,
              onSelect: () => splitActive("column"),
            },
            {
              label: t("tab.closeOthers"),
              separatorBefore: true,
              disabled: !activeTab || items.length < 2,
              onSelect: () => {
                if (activeTab) closeOthers(activeTab.id);
              },
            },
            {
              label: t(pane.locked ? "tab.unlockPane" : "tab.lockPane"),
              separatorBefore: true,
              onSelect: () => togglePaneLock(pane.id),
            },
            ...(activeSidebarView
              ? sidebarMoveActions(activeSidebarView, t).map((action, index) => ({
                  ...action,
                  separatorBefore: index === 0 || action.separatorBefore,
                }))
              : []),
            ...(paneCount > 1
              ? [{ label: t("tab.closePane"), separatorBefore: true, onSelect: closeGroup }]
              : []),
          ]}
        />
      </div>
    </div>
  );
}

type DropHint = "left" | "right" | "top" | "bottom";

export function zoneOf(
  element: HTMLDivElement,
  event: { clientX: number; clientY: number },
): DropHint | null {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  // Keep the middle quarter for merging; divide the remainder by the nearest
  // edge so corners do not make the top and bottom targets unreachable.
  if (x >= 0.375 && x <= 0.625 && y >= 0.375 && y <= 0.625) return null;
  const distances: [DropHint, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
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
      if (!event.dataTransfer?.types.some((type) => type === TAB_MIME || type === FILE_PANE_MIME))
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setHint(zoneOf(element, event));
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget))
        setHint(null);
    };
    const drop = (event: globalThis.DragEvent) => {
      const token = event.dataTransfer?.getData(FILE_PANE_MIME);
      const draggedFile = token ? filePaneDrag(token) : null;
      let tabId = event.dataTransfer?.getData(TAB_MIME);
      if (!tabId && !draggedFile) return;
      event.preventDefault();
      event.stopPropagation();
      setHint(null);
      const zone = zoneOf(element, event);
      if (draggedFile)
        tabId = useWorkspace.getState().openFilePane(draggedFile.pane, draggedFile.title);
      if (!tabId) return;
      if (!zone) {
        moveTab(tabId, pane.id);
        draggedFile?.onMoved?.();
        return;
      }
      const direction: SplitDirection = zone === "left" || zone === "right" ? "row" : "column";
      splitTab(tabId, direction, zone === "left" || zone === "top" ? "before" : "after", pane.id);
      draggedFile?.onMoved?.();
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
      data-pane-id={pane.id}
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
