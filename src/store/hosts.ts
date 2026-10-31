// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { Group, Host, HostInput } from "@/lib/api/types";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";

interface HostsStore {
  groups: Group[];
  hosts: Host[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<boolean>;
  createHost: (input: HostInput) => Promise<Host | null>;
  updateHost: (id: string, input: HostInput) => Promise<Host | null>;
  deleteHost: (id: string) => Promise<boolean>;
  moveHost: (dragId: string, targetId: string, position?: "before" | "after") => void;
  moveToGroup: (id: string, groupId: string | null, favorite?: boolean) => void;
  toggleFavorite: (host: Host) => Promise<void>;
  createGroup: (name: string, parentId?: string | null) => Promise<Group | null>;
  renameGroup: (id: string, name: string) => Promise<boolean>;
  deleteGroup: (id: string) => Promise<boolean>;
}

let snapshotVersion = 0;
let editVersion = 0;
const mutations: Array<() => Promise<void>> = [];
let running = false;
const idleWaiters: Array<() => void> = [];

function queueMutation(operation: () => Promise<void>): void {
  mutations.push(operation);
  if (running) return;
  running = true;
  void (async () => {
    let failed = false;
    while (mutations.length) {
      const next = mutations.shift()!;
      try {
        await next();
      } catch (error) {
        failed = true;
        toast(translateError(error), "error");
      }
    }
    running = false;
    idleWaiters.splice(0).forEach((resolve) => resolve());
    if (failed) await useHosts.getState().load();
  })();
}

function hostInput(host: Host): HostInput {
  const {
    name,
    host: address,
    port,
    username,
    authMethod,
    keyPath,
    groupId,
    favorite,
    color,
    tags,
    note,
  } = host;
  return {
    name,
    host: address,
    port,
    username,
    authMethod,
    keyPath,
    groupId,
    favorite,
    color,
    tags,
    note,
  };
}

function persistPlacement(
  id: string,
  patch: Pick<Host, "groupId" | "favorite">,
  order: string[],
): void {
  queueMutation(async () => {
    const host = useHosts.getState().hosts.find((item) => item.id === id);
    if (!host) return;
    await api.updateHost(id, { ...hostInput(host), ...patch });
    await api.hostsReorder(order);
  });
}

export const useHosts = create<HostsStore>((set, get) => ({
  groups: [],
  hosts: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (running) await new Promise<void>((resolve) => idleWaiters.push(resolve));
    const request = ++snapshotVersion;
    const revision = editVersion;
    set({ loading: true });
    try {
      const snapshot = await api.hostsSnapshot();
      if (request !== snapshotVersion || revision !== editVersion) return false;
      set({ groups: snapshot.groups, hosts: snapshot.hosts, loaded: true, loading: false });
      return true;
    } catch (error) {
      if (request !== snapshotVersion || revision !== editVersion) return false;
      set({ loading: false });
      toast(translateError(error), "error");
      return false;
    }
  },

  createHost: async (input) => {
    try {
      const host = await api.createHost(input);
      await get().load();
      toast(i18n.t("toast.hostCreated"), "success");
      return host;
    } catch (error) {
      toast(translateError(error), "error");
      return null;
    }
  },

  updateHost: async (id, input) => {
    try {
      const host = await api.updateHost(id, input);
      await get().load();
      toast(i18n.t("toast.hostUpdated"), "success");
      return host;
    } catch (error) {
      toast(translateError(error), "error");
      return null;
    }
  },

  deleteHost: async (id) => {
    try {
      await api.deleteHost(id);
      await get().load();
      toast(i18n.t("toast.hostDeleted"), "success");
      return true;
    } catch (error) {
      toast(translateError(error), "error");
      return false;
    }
  },

  moveHost: (dragId, targetId, position = "before") => {
    if (dragId === targetId) {
      return;
    }
    const current = get().hosts;
    const dragged = current.find((host) => host.id === dragId);
    const target = current.find((host) => host.id === targetId);
    if (!dragged || !target) {
      return;
    }
    const rest = current.filter((host) => host.id !== dragId);
    const index = rest.findIndex((host) => host.id === targetId) + (position === "after" ? 1 : 0);
    if (index < 0) {
      return;
    }
    const placed = { ...dragged, groupId: target.groupId, favorite: target.favorite };
    const next = [...rest.slice(0, index), placed, ...rest.slice(index)].map((host, position) => ({
      ...host,
      sortOrder: position,
    }));
    editVersion++;
    set({ hosts: next, loading: false });
    const order = next.map((host) => host.id);
    if (dragged.groupId !== placed.groupId || dragged.favorite !== placed.favorite) {
      persistPlacement(dragId, placed, order);
    } else queueMutation(() => api.hostsReorder(order));
  },

  moveToGroup: (id, groupId, favorite = false) => {
    if (groupId && !get().groups.some((group) => group.id === groupId)) return;
    const current = get().hosts;
    const host = current.find((item) => item.id === id);
    if (!host || (host.groupId === groupId && host.favorite === favorite)) return;
    const next = [...current.filter((item) => item.id !== id), { ...host, groupId, favorite }].map(
      (item, index) => ({ ...item, sortOrder: index }),
    );
    editVersion++;
    set({ hosts: next, loading: false });
    persistPlacement(
      id,
      { groupId, favorite },
      next.map((item) => item.id),
    );
  },

  toggleFavorite: async (host) => {
    const latest = get().hosts.find((item) => item.id === host.id);
    if (!latest) return;
    const favorite = !latest.favorite;
    editVersion++;
    set((state) => ({
      hosts: state.hosts.map((item) => (item.id === host.id ? { ...item, favorite } : item)),
      loading: false,
    }));
    queueMutation(async () => {
      const current = get().hosts.find((item) => item.id === host.id);
      if (current) await api.updateHost(host.id, { ...hostInput(current), favorite });
    });
  },

  createGroup: async (name, parentId = null) => {
    try {
      const group = await api.createGroup({ name, parentId });
      await get().load();
      toast(i18n.t("toast.groupCreated"), "success");
      return group;
    } catch (error) {
      toast(translateError(error), "error");
      return null;
    }
  },

  renameGroup: async (id, name) => {
    try {
      await api.updateGroup(id, { name });
      await get().load();
      return true;
    } catch (error) {
      toast(translateError(error), "error");
      return false;
    }
  },

  deleteGroup: async (id) => {
    try {
      await api.deleteGroup(id);
      await get().load();
      toast(i18n.t("toast.groupDeleted"), "success");
      return true;
    } catch (error) {
      toast(translateError(error), "error");
      return false;
    }
  },
}));
