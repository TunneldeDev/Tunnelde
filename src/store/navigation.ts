// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
import { create } from "zustand";

export type SettingsSection = "general" | "appearance" | "files" | "css" | "updates" | "advanced";
export type SidebarView = "hosts" | "knownHosts" | "plugins";

export const useNavigation = create<{
  sidebarVisible: boolean;
  activeSidebar: SidebarView;
  visitedSidebars: SidebarView[];
  settingsSection: SettingsSection;
  toggleSidebar: () => void;
  selectSidebar: (view: SidebarView) => void;
  showSidebar: (view: SidebarView) => void;
  selectSettings: (section: SettingsSection) => void;
}>((set) => ({
  sidebarVisible: true,
  activeSidebar: "hosts",
  visitedSidebars: ["hosts"],
  settingsSection: "general",
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  selectSidebar: (activeSidebar) =>
    set((state) => ({
      activeSidebar,
      sidebarVisible: state.activeSidebar === activeSidebar ? !state.sidebarVisible : true,
      visitedSidebars: state.visitedSidebars.includes(activeSidebar)
        ? state.visitedSidebars
        : [...state.visitedSidebars, activeSidebar],
    })),
  showSidebar: (activeSidebar) =>
    set((state) => ({
      activeSidebar,
      sidebarVisible: true,
      visitedSidebars: state.visitedSidebars.includes(activeSidebar)
        ? state.visitedSidebars
        : [...state.visitedSidebars, activeSidebar],
    })),
  selectSettings: (settingsSection) => set({ settingsSection }),
}));
