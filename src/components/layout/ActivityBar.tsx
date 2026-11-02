import {
  Blocks,
  Bot,
  Folder,
  MessageCircle,
  MessageSquare,
  Network,
  Plug,
  Server,
  Settings,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { useContextMenu } from "@/store/contextMenu";
import { sidebarMoveActions } from "./SidebarDockControls";
import {
  sidebarLabel,
  SIDEBAR_MIME,
  sidebarTabId,
  sidebarViewOf,
  TAB_MIME,
} from "@/lib/session/sidebarDock";
import { usePlugins } from "@/store/plugins";
import { pluginSidebars } from "@/lib/plugins/sidebars";
import type { SidebarView } from "@/store/navigation";
import { useQuickAccess } from "@/store/quickAccess";

const PLUGIN_ICONS = {
  bot: Bot,
  "message-square": MessageSquare,
  "message-circle": MessageCircle,
  sparkles: Sparkles,
  blocks: Blocks,
  network: Network,
  terminal: Terminal,
  wrench: Wrench,
  plug: Plug,
  server: Server,
  folder: Folder,
  shield: Shield,
};

export function ActivityBar() {
  const { t } = useTranslation();
  const visible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const select = useNavigation((state) => state.selectSidebar);
  const openPage = useWorkspace((state) => state.openPage);
  const kind = useWorkspace((state) => state.tabs.find((tab) => tab.id === state.activeId)?.kind);
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const plugins = usePlugins((state) => state.items);
  const views = [
    { view: "hosts", Icon: Server },
    { view: "knownHosts", Icon: ShieldCheck },
    { view: "plugins", Icon: Blocks },
    ...pluginSidebars(plugins).map((view) => ({
      view: view.view,
      Icon:
        PLUGIN_ICONS[view.icon as keyof typeof PLUGIN_ICONS] ??
        (view.kind === "chat" ? Bot : Blocks),
    })),
  ] satisfies { view: SidebarView; Icon: typeof Server }[];
  const selectView = async (view: SidebarView) => {
    const current = useWorkspace.getState();
    const currentTab = current.tabs.find((tab) => tab.id === sidebarTabId(view));
    if (
      currentTab &&
      !currentTab.hidden &&
      current.panes.some((pane) => pane.activeId === currentTab.id)
    ) {
      current.toggleDockedSidebar(view);
      return;
    }
    const contribution = pluginSidebars(usePlugins.getState().items).find(
      (item) => item.view === view,
    );
    if (
      contribution &&
      usePlugins.getState().items.find((item) => item.id === contribution.pluginId)?.status !==
        "running"
    ) {
      await usePlugins.getState().start(contribution.pluginId);
      if (
        usePlugins.getState().items.find((item) => item.id === contribution.pluginId)?.status !==
        "running"
      )
        return;
    }
    const workspace = useWorkspace.getState();
    if (workspace.tabs.some((tab) => tab.id === sidebarTabId(view)))
      workspace.toggleDockedSidebar(view);
    else select(view);
  };
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
        const tab = tabs.find((tab) => tab.id === id);
        const docked = !!tab;
        const expanded = docked
          ? !tab.hidden && panes.some((pane) => pane.activeId === id)
          : visible && activeSidebar === view;
        return (
          <IconButton
            key={view}
            label={sidebarLabel(view, t)}
            active={docked ? expanded : activeSidebar === view}
            aria-expanded={expanded}
            aria-controls={`sidebar-${view}`}
            onClick={() => void selectView(view)}
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
      <IconButton label={t("palette.title")} onClick={() => useQuickAccess.getState().show(">")}>
        <Search size={21} />
      </IconButton>
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
