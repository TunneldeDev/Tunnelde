import { Blocks, Server, Settings, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { useContextMenu } from "@/store/contextMenu";
import { sidebarMoveActions } from "./SidebarDockControls";
import {
  SIDEBAR_LABELS,
  SIDEBAR_MIME,
  sidebarTabId,
  sidebarViewOf,
  TAB_MIME,
} from "@/lib/session/sidebarDock";

export function ActivityBar() {
  const { t } = useTranslation();
  const visible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const select = useNavigation((state) => state.selectSidebar);
  const openPage = useWorkspace((state) => state.openPage);
  const kind = useWorkspace((state) => state.tabs.find((tab) => tab.id === state.activeId)?.kind);
  const tabs = useWorkspace((state) => state.tabs);
  const activeId = useWorkspace((state) => state.activeId);
  const panes = useWorkspace((state) => state.panes);
  const views = [
    { view: "hosts", Icon: Server },
    { view: "knownHosts", Icon: ShieldCheck },
    { view: "plugins", Icon: Blocks },
  ] as const;
  return (
    <nav
      className="activitybar"
      aria-label={t("nav.workspace")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SIDEBAR_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        event.currentTarget.classList.add("is-return-target");
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          event.currentTarget.classList.remove("is-return-target");
      }}
      onDrop={(event) => {
        event.currentTarget.classList.remove("is-return-target");
        const view = sidebarViewOf(event.dataTransfer.getData(TAB_MIME));
        if (!view) return;
        event.preventDefault();
        event.stopPropagation();
        useWorkspace.getState().returnSidebar(view);
      }}
    >
      {views.map(({ view, Icon }) => {
        const id = sidebarTabId(view);
        const docked = tabs.some((tab) => tab.id === id);
        return (
          <IconButton
            key={view}
            label={t(SIDEBAR_LABELS[view])}
            active={docked ? activeId === id : activeSidebar === view}
            aria-expanded={
              docked
                ? panes.some((pane) => pane.activeId === id)
                : visible && activeSidebar === view
            }
            aria-controls={`sidebar-${view}`}
            onClick={() => select(view)}
            onContextMenu={(event) => {
              event.preventDefault();
              useContextMenu
                .getState()
                .open(
                  event.clientX,
                  event.clientY,
                  sidebarMoveActions(view, t),
                  event.currentTarget,
                );
            }}
          >
            <Icon size={21} />
          </IconButton>
        );
      })}
      <span className="activitybar__spacer" />
      <IconButton
        label={t("nav.settings")}
        active={kind === "settings"}
        onClick={() => openPage("settings")}
      >
        <Settings size={21} />
      </IconButton>
    </nav>
  );
}
