// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { applyAppearance, resolveLanguage } from "@/lib/prefs/appearance";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { api, isTauri } from "@/lib/api/ipc";
import type { AppInfo, Settings, SettingsPatch } from "@/lib/api/types";
import { setLanguage } from "@/i18n/i18n";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

let requestedLocale: string | undefined;
let appliedLocale: string | undefined;
let changingLocale = false;

function applyNativeLocale(language: string): void {
  requestedLocale = language;
  if (changingLocale || appliedLocale === language) return;
  changingLocale = true;
  void (async () => {
    try {
      while (requestedLocale !== appliedLocale) {
        const next: string = requestedLocale!;
        try {
          await api.setLocale(next);
          appliedLocale = next;
        } catch {
          // Retry on the next settings application; never leave a rejected queue.
          if (requestedLocale === next) break;
        }
      }
    } finally {
      changingLocale = false;
    }
  })();
}

interface SettingsStore {
  settings: Settings;
  info: AppInfo | null;
  ready: boolean;
  error: string | null;
  load: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<boolean>;
  reset: () => Promise<void>;
  applyRemote: (settings: Settings) => void;
}

export function applySettings(settings: Settings): void {
  applyAppearance(settings);
  const language = resolveLanguage(settings.language, [
    ...(useSettings.getState().info?.systemLanguages ?? []),
    ...navigatorLanguages(),
  ]);
  setLanguage(language);
  if (isTauri()) {
    applyNativeLocale(language);
  }
}

/** The OS UI language reported by the webview, best match first. */
function navigatorLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  return list.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export const useSettings = create<SettingsStore>((set, get) => {
  let queue: Promise<unknown> = Promise.resolve();
  let loading: Promise<void> | null = null;
  let confirmed = DEFAULT_SETTINGS;
  let remoteRevision = 0;
  const pending: SettingsPatch[] = [];
  const display = () => {
    const settings = pending.reduce<Settings>(
      (value, patch) => ({ ...value, ...patch }),
      confirmed,
    );
    applySettings(settings);
    set({ settings });
  };
  const commit = (patch: SettingsPatch, reset = false): Promise<boolean> => {
    if (pending.length === 0) confirmed = get().settings;
    pending.push(patch);
    display();
    const task = queue.then(async () => {
      let ok = true;
      try {
        confirmed = isTauri()
          ? await (reset ? api.resetSettings() : api.updateSettings(patch))
          : { ...confirmed, ...patch };
        set({ error: null });
      } catch (error) {
        ok = false;
        set({ error: translateError(error) });
        toast(translateError(error), "error");
      } finally {
        pending.shift();
        display();
      }
      return ok;
    });
    queue = task.catch(() => undefined);
    return task;
  };
  return {
    settings: DEFAULT_SETTINGS,
    info: null,
    ready: false,
    error: null,

    load: () => {
      if (loading) return loading;
      const task = queue.then(async () => {
        if (!isTauri()) {
          display();
          set({ ready: true });
          return;
        }
        const revision = remoteRevision;
        const [settings, info] = await Promise.allSettled([api.settings(), api.appInfo()]);
        if (settings.status === "fulfilled" && revision === remoteRevision) {
          confirmed = settings.value;
        }
        if (info.status === "fulfilled") set({ info: info.value });
        const failed =
          settings.status === "rejected" ? settings : info.status === "rejected" ? info : null;
        set({ ready: true, error: failed ? translateError(failed.reason) : null });
        display();
      });
      queue = task.catch(() => undefined);
      loading = task.finally(() => {
        loading = null;
      });
      return loading;
    },

    update: (patch) => commit(patch),

    reset: async () => {
      if (await commit(DEFAULT_SETTINGS, true)) toast(i18n.t("toast.reset"), "success");
    },

    applyRemote: (settings) => {
      remoteRevision++;
      confirmed = settings;
      display();
    },
  };
});

export const settingsStore = useSettings;
