// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
import { create } from "zustand";

export type SettingsSection =
  "general" | "appearance" | "files" | "plugins" | "hosts" | "css" | "updates" | "advanced";

export const useNavigation = create<{
  sidebarVisible: boolean;
  settingsSection: SettingsSection;
  toggleSidebar: () => void;
  selectSettings: (section: SettingsSection) => void;
}>((set) => ({
  sidebarVisible: true,
  settingsSection: "general",
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  selectSettings: (settingsSection) => set({ settingsSection }),
}));
