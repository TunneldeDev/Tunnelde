// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import type { UpdateState } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";

interface UpdatesStore {
  state: UpdateState | null;
  busy: boolean;
  refresh: () => Promise<void>;
  check: (force?: boolean) => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  apply: (state: UpdateState) => void;
}

export const useUpdates = create<UpdatesStore>((set, get) => ({
  state: null,
  busy: false,

  refresh: async () => {
    if (!isTauri()) {
      return;
    }
    try {
      set({ state: await api.updateState() });
    } catch {
      // A missing update state is not worth interrupting startup.
    }
  },

  check: async (force = true) => {
    if (!isTauri() || get().busy) {
      return;
    }
    set({ busy: true });
    try {
      const state = await api.checkUpdates(force);
      set({ state, busy: false });
    } catch (error) {
      set({ busy: false });
      toast(translateError(error), "error");
    }
  },

  install: async () => {
    if (!isTauri()) {
      return;
    }
    set({ busy: true });
    try {
      await api.installUpdate();
    } catch (error) {
      set({ busy: false });
      toast(translateError(error), "error");
    }
  },

  skip: async () => {
    const version = get().state?.version;
    if (!version) {
      return;
    }
    await useSettings.getState().update({ skippedVersion: version });
    const state = get().state;
    if (state) {
      set({ state: { ...state, skipped: true } });
    }
  },

  apply: (state) => set({ state }),
}));
