// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/errors";
import { api } from "@/lib/ipc";
import type { Group, Host, HostInput } from "@/lib/types";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";

interface HostsStore {
  groups: Group[];
  hosts: Host[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  createHost: (input: HostInput) => Promise<Host | null>;
  updateHost: (id: string, input: HostInput) => Promise<Host | null>;
  deleteHost: (id: string) => Promise<boolean>;
  toggleFavorite: (host: Host) => Promise<void>;
  createGroup: (name: string, parentId?: string | null) => Promise<Group | null>;
  renameGroup: (id: string, name: string) => Promise<boolean>;
  deleteGroup: (id: string) => Promise<boolean>;
}

export const useHosts = create<HostsStore>((set, get) => ({
  groups: [],
  hosts: [],
  loaded: false,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const snapshot = await api.hostsSnapshot();
      set({ groups: snapshot.groups, hosts: snapshot.hosts, loaded: true, loading: false });
    } catch (error) {
      set({ loading: false });
      toast(translateError(error), "error");
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

  toggleFavorite: async (host) => {
    try {
      await api.updateHost(host.id, {
        name: host.name,
        host: host.host,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod,
        groupId: host.groupId,
        favorite: !host.favorite,
        color: host.color,
        tags: host.tags,
        note: host.note,
      });
      await get().load();
    } catch (error) {
      toast(translateError(error), "error");
    }
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
