import { GripVertical } from "lucide-react";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menu, type MenuAction } from "@/components/ui/overlay/Menu";
import { useContextMenu } from "@/store/contextMenu";
import { useWorkspace } from "@/store/workspace";
import type { SidebarView } from "@/store/navigation";
import { SIDEBAR_MIME, sidebarTabId, TAB_MIME } from "@/lib/session/sidebarDock";

export function sidebarMoveActions(view: SidebarView, t: TFunction): MenuAction[] {
  const workspace = useWorkspace.getState();
  const id = sidebarTabId(view);
  const docked = workspace.tabs.some((tab) => tab.id === id);
  return [
    docked
      ? {
          label: t("docking.returnToSidebar"),
          onSelect: () => useWorkspace.getState().returnSidebar(view),
        }
      : {
          label: t("docking.moveToWorkspace"),
          onSelect: () => useWorkspace.getState().openSidebar(view),
        },
    ...(
      [
        ["moveLeft", "row", "before"],
        ["moveRight", "row", "after"],
        ["moveTop", "column", "before"],
        ["moveBottom", "column", "after"],
      ] as const
    ).map(([label, direction, position], index) => ({
      label: t(`docking.${label}`),
      separatorBefore: index === 0,
      onSelect: () => {
        const state = useWorkspace.getState();
        state.splitTab(id, direction, position, state.activePaneId);
      },
    })),
  ];
}

export function SidebarDockControls({ view }: { view: SidebarView }) {
  const { t } = useTranslation();
  const docked = useWorkspace((state) => state.tabs.some((tab) => tab.id === sidebarTabId(view)));
  return (
    <Menu
      label={t(docked ? "docking.returnToSidebar" : "docking.moveToWorkspace")}
      items={sidebarMoveActions(view, t)}
    />
  );
}

export function SidebarTitle({ view, children }: { view: SidebarView; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span
      className="sidebar__title sidebar-drag-title"
      draggable
      title={t("docking.dragHint")}
      onDragStart={(event) => {
        event.dataTransfer.setData(TAB_MIME, sidebarTabId(view));
        event.dataTransfer.setData(SIDEBAR_MIME, view);
        event.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        useContextMenu
          .getState()
          .open(event.clientX, event.clientY, sidebarMoveActions(view, t), event.currentTarget);
      }}
    >
      <GripVertical size={11} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
