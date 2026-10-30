// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { toast } from "@/store/toasts";

export interface PluginOutput {
  text: string;
  error: boolean;
}

interface PluginsStore {
  items: PluginInfo[];
  busy: string | null;
  outputs: Record<string, PluginOutput>;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  install: (path: string) => Promise<boolean>;
  apply: (info: PluginInfo) => void;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  run: (id: string, command: string) => Promise<void>;
}

export const usePlugins = create<PluginsStore>((set, get) => ({
  items: [],
  busy: null,
  outputs: {},

  load: async () => {
    try {
      set({ items: await api.pluginsList() });
    } catch (error) {
      toast(translateError(error), "error");
    }
  },

  reload: async () => {
    try {
      set({ items: await api.pluginReload() });
    } catch (error) {
      toast(translateError(error), "error");
    }
  },

  install: async (path) => {
    try {
      await api.pluginInstall(path);
      set({ items: await api.pluginsList() });
      return true;
    } catch (error) {
      toast(translateError(error), "error");
      return false;
    }
  },

  apply: (info) => {
    set((state) => ({
      items: state.items.map((item) => (item.id === info.id ? info : item)),
    }));
  },

  start: async (id) => {
    set({ busy: id });
    try {
      get().apply(await api.pluginStart(id));
    } catch (error) {
      toast(translateError(error), "error");
    } finally {
      set({ busy: null });
    }
  },

  stop: async (id) => {
    set({ busy: id });
    try {
      get().apply(await api.pluginStop(id));
    } catch (error) {
      toast(translateError(error), "error");
    } finally {
      set({ busy: null });
    }
  },

  run: async (id, command) => {
    set({ busy: id });
    try {
      const result = await api.pluginRun(id, command);
      set((state) => ({
        outputs: {
          ...state.outputs,
          [id]: { text: JSON.stringify(result, null, 2), error: false },
        },
      }));
    } catch (error) {
      set((state) => ({
        outputs: {
          ...state.outputs,
          [id]: { text: translateError(error), error: true },
        },
      }));
    } finally {
      set({ busy: null });
    }
  },
}));
