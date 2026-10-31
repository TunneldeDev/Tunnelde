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
  busyIds: string[];
  reloading: boolean;
  outputs: Record<string, PluginOutput>;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  install: (path: string) => Promise<boolean>;
  apply: (info: PluginInfo) => void;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  run: (id: string, command: string) => Promise<void>;
}

export const usePlugins = create<PluginsStore>((set, get) => {
  const operations = new Map<string, Promise<void>>();
  const installations = new Map<string, Promise<boolean>>();
  const revisions = new Map<string, number>();
  let revision = 0;
  let listRequest = 0;
  let reloadRequest: Promise<void> | null = null;

  const touch = (id: string) => {
    revisions.set(id, ++revision);
    return revision;
  };

  const readList = async (request: () => Promise<PluginInfo[]>) => {
    const requestId = ++listRequest;
    const startedAt = revision;
    try {
      const items = await request();
      if (requestId !== listRequest) return;
      set((state) => {
        const current = new Map(state.items.map((item) => [item.id, item]));
        const changed = (id: string) => (revisions.get(id) ?? 0) > startedAt || operations.has(id);
        const ids = new Set(items.map((item) => item.id));
        return {
          items: [
            ...items.map((item) => (changed(item.id) ? (current.get(item.id) ?? item) : item)),
            ...state.items.filter((item) => !ids.has(item.id) && changed(item.id)),
          ],
        };
      });
    } catch (error) {
      if (requestId === listRequest) toast(translateError(error), "error");
    }
  };

  // A plugin has one runtime: conflicting actions share its pending operation.
  // Other plugins remain independently usable while it is busy.
  const operate = (id: string, action: (startedAt: number) => Promise<void>) => {
    const pending = operations.get(id);
    if (pending) return pending;
    const pendingReload = reloadRequest;
    touch(id);
    const request = Promise.resolve().then(async () => {
      try {
        if (pendingReload) await pendingReload;
        await action(touch(id));
      } finally {
        operations.delete(id);
        const busyIds = [...operations.keys()];
        set({ busyIds, busy: busyIds[0] ?? null });
      }
    });
    operations.set(id, request);
    const busyIds = [...operations.keys()];
    set({ busyIds, busy: busyIds[0] ?? null });
    return request;
  };

  const changeStatus = (id: string, request: () => Promise<PluginInfo>) =>
    operate(id, async (startedAt) => {
      try {
        const info = await request();
        // A pushed failure/status event may already be newer than this response.
        if (revisions.get(id) === startedAt) get().apply(info);
      } catch (error) {
        toast(translateError(error), "error");
      }
    });

  return {
    items: [],
    busy: null,
    busyIds: [],
    reloading: false,
    outputs: {},

    load: () => reloadRequest ?? readList(api.pluginsList),

    reload: () => {
      if (reloadRequest) return reloadRequest;
      ++listRequest;
      const pending = [...operations.values(), ...installations.values()];
      reloadRequest = Promise.resolve()
        .then(async () => {
          await Promise.allSettled(pending);
          await readList(api.pluginReload);
        })
        .finally(() => {
          reloadRequest = null;
          set({ reloading: false });
        });
      set({ reloading: true });
      return reloadRequest;
    },

    install: (path) => {
      const existing = installations.get(path);
      if (existing) return existing;
      const pendingReload = reloadRequest;
      const request = Promise.resolve()
        .then(async () => {
          try {
            if (pendingReload) await pendingReload;
            get().apply(await api.pluginInstall(path));
            await readList(api.pluginsList);
            return true;
          } catch (error) {
            toast(translateError(error), "error");
            return false;
          }
        })
        .finally(() => installations.delete(path));
      installations.set(path, request);
      return request;
    },

    apply: (info) => {
      touch(info.id);
      set((state) => ({
        items: state.items.some((item) => item.id === info.id)
          ? state.items.map((item) => (item.id === info.id ? info : item))
          : [...state.items, info],
      }));
    },

    start: (id) => changeStatus(id, () => api.pluginStart(id)),
    stop: (id) => changeStatus(id, () => api.pluginStop(id)),

    run: (id, command) =>
      operate(id, async () => {
        let output: PluginOutput;
        try {
          const result = await api.pluginRun(id, command);
          output = { text: JSON.stringify(result, null, 2), error: false };
        } catch (error) {
          output = { text: translateError(error), error: true };
        }
        set((state) => ({ outputs: { ...state.outputs, [id]: output } }));
      }),
  };
});
