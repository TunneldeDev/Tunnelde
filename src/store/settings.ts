// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { applyAppearance, resolveLanguage } from "@/lib/appearance";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { api, isTauri } from "@/lib/ipc";
import type { AppInfo, Settings, SettingsPatch } from "@/lib/types";
import { setLanguage } from "@/i18n/i18n";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/errors";

interface SettingsStore {
  settings: Settings;
  info: AppInfo | null;
  ready: boolean;
  error: string | null;
  load: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<void>;
  reset: () => Promise<void>;
  applyRemote: (settings: Settings) => void;
}

export function applySettings(settings: Settings): void {
  applyAppearance(settings);
  const language = resolveLanguage(settings.language);
  setLanguage(language);
  if (isTauri()) {
    void api.setLocale(language).catch(() => undefined);
  }
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  info: null,
  ready: false,
  error: null,

  load: async () => {
    if (!isTauri()) {
      applySettings(DEFAULT_SETTINGS);
      set({ ready: true });
      return;
    }
    try {
      const [settings, info] = await Promise.all([api.settings(), api.appInfo()]);
      applySettings(settings);
      set({ settings, info, ready: true, error: null });
    } catch (error) {
      set({ ready: true, error: translateError(error) });
    }
  },

  update: async (patch) => {
    const previous = useSettings.getState().settings;
    set({ settings: { ...previous, ...patch } });
    if (!isTauri()) {
      applySettings({ ...previous, ...patch });
      return;
    }
    try {
      const settings = await api.updateSettings(patch);
      applySettings(settings);
      set({ settings, error: null });
    } catch (error) {
      set({ settings: previous, error: translateError(error) });
      applySettings(previous);
      toast(translateError(error), "error");
    }
  },

  reset: async () => {
    if (!isTauri()) {
      applySettings(DEFAULT_SETTINGS);
      set({ settings: DEFAULT_SETTINGS });
      return;
    }
    try {
      const settings = await api.resetSettings();
      applySettings(settings);
      set({ settings });
      toast(i18n.t("toast.reset"), "success");
    } catch (error) {
      toast(translateError(error), "error");
    }
  },

  applyRemote: (settings) => {
    applySettings(settings);
    set({ settings });
  },
}));

export const settingsStore = useSettings;
