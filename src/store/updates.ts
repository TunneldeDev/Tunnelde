import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import type { Settings, UpdateState } from "@/lib/api/types";
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

let refreshVersion = 0;

export function matchingUpdateState(
  state: UpdateState | null,
  settings: Settings,
): UpdateState | null {
  return state?.channel === settings.updateChannel &&
    state.source === settings.updateSource &&
    state.sourceUrl === settings.updateSourceUrl
    ? state
    : null;
}

export const useUpdates = create<UpdatesStore>((set, get) => ({
  state: null,
  busy: false,

  refresh: async () => {
    if (!isTauri()) {
      return;
    }
    const request = ++refreshVersion;
    const previous = get().state;
    try {
      const state = await api.updateState();
      if (request === refreshVersion && get().state === previous) set({ state });
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
    if (!isTauri() || get().busy) {
      return;
    }
    set({ busy: true });
    try {
      await api.installUpdate();
    } catch (error) {
      set({ busy: false });
      toast(translateError(error), "error");
    } finally {
      set({ busy: false });
    }
  },

  skip: async () => {
    const version = matchingUpdateState(get().state, useSettings.getState().settings)?.version;
    if (!version) {
      return;
    }
    if (!(await useSettings.getState().update({ skippedVersion: version }))) return;
    const state = matchingUpdateState(get().state, useSettings.getState().settings);
    if (state?.version === version) {
      set({ state: { ...state, skipped: true } });
    }
  },

  apply: (state) => set({ state }),
}));
