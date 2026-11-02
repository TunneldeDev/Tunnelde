import { create } from "zustand";
import { useWorkspace } from "@/store/workspace";
import { sidebarTabId, SIDEBAR_VIEWS } from "@/lib/session/sidebarDock";
import type { PluginSidebarView } from "@/lib/plugins/sidebars";

export type SettingsSection =
  | "general"
  | "appearance"
  | "workspace"
  | "terminal"
  | "shortcuts"
  | "files"
  | "editor"
  | "monitor"
  | "plugins"
  | "updates"
  | "advanced";
export type BuiltinSidebarView = "hosts" | "knownHosts" | "plugins";
export type SidebarView = BuiltinSidebarView | PluginSidebarView;

export const useNavigation = create<{
  sidebarVisible: boolean;
  activeSidebar: SidebarView;
  visitedSidebars: SidebarView[];
  settingsSection: SettingsSection;
  toggleSidebar: () => void;
  selectSidebar: (view: SidebarView) => void;
  showSidebar: (view: SidebarView) => void;
  rememberSidebar: (view: SidebarView) => void;
  selectSettings: (section: SettingsSection) => void;
}>((set) => ({
  sidebarVisible: true,
  activeSidebar: "hosts",
  visitedSidebars: ["hosts"],
  settingsSection: "general",
  toggleSidebar: () =>
    set((state) => {
      const tabs = useWorkspace.getState().tabs;
      const docked = tabs.some((tab) => tab.id === sidebarTabId(state.activeSidebar));
      if (docked) {
        const available = SIDEBAR_VIEWS.find(
          (view) => !tabs.some((tab) => tab.id === sidebarTabId(view)),
        );
        return available
          ? {
              activeSidebar: available,
              sidebarVisible: true,
              visitedSidebars: state.visitedSidebars.includes(available)
                ? state.visitedSidebars
                : [...state.visitedSidebars, available],
            }
          : state;
      }
      return { sidebarVisible: !state.sidebarVisible };
    }),
  rememberSidebar: (view) =>
    set((state) =>
      state.visitedSidebars.includes(view)
        ? state
        : { visitedSidebars: [...state.visitedSidebars, view] },
    ),
  selectSidebar: (activeSidebar) => {
    const workspace = useWorkspace.getState();
    if (workspace.tabs.some((tab) => tab.id === sidebarTabId(activeSidebar))) {
      workspace.activate(sidebarTabId(activeSidebar));
      return;
    }
    set((state) => ({
      activeSidebar,
      sidebarVisible: state.activeSidebar === activeSidebar ? !state.sidebarVisible : true,
      visitedSidebars: state.visitedSidebars.includes(activeSidebar)
        ? state.visitedSidebars
        : [...state.visitedSidebars, activeSidebar],
    }));
  },
  showSidebar: (activeSidebar) => {
    const workspace = useWorkspace.getState();
    if (workspace.tabs.some((tab) => tab.id === sidebarTabId(activeSidebar))) {
      workspace.activate(sidebarTabId(activeSidebar));
      return;
    }
    set((state) => ({
      activeSidebar,
      sidebarVisible: true,
      visitedSidebars: state.visitedSidebars.includes(activeSidebar)
        ? state.visitedSidebars
        : [...state.visitedSidebars, activeSidebar],
    }));
  },
  selectSettings: (settingsSection) => set({ settingsSection }),
}));
