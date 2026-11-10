import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import type { ReleaseHistory, Settings, UpdateState } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";
import i18n from "@/i18n/i18n";
import { isIpcError } from "@/lib/api/types";
import { useWorkspace } from "@/store/workspace";

interface UpdatesStore {
  state: UpdateState | null;
  busy: boolean;
  history: {
    key: string;
    loading: boolean;
    data: ReleaseHistory | null;
    error: string | null;
  } | null;
  loadHistory: (retry?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  check: (force?: boolean) => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  apply: (state: UpdateState) => void;
}

let refreshVersion = 0;
let historyRequest = 0;

export function updateHistoryKey(state: UpdateState): string {
  return JSON.stringify([
    state.currentVersion,
    state.version,
    state.channel,
    state.source,
    state.sourceUrl,
    state.lastChecked,
  ]);
}

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
  history: null,

  loadHistory: async (retry = false) => {
    const snapshot = matchingUpdateState(get().state, useSettings.getState().settings);
    if (!isTauri() || !snapshot?.available || !snapshot.version) return;
    const key = updateHistoryKey(snapshot);
    const previous = get().history;
    if (previous?.key === key && (previous.loading || !retry)) return;
    const request = ++historyRequest;
    set({
      history: {
        key,
        loading: true,
        data: previous?.key === key ? previous.data : null,
        error: null,
      },
    });
    try {
      const data = await api.updateHistory(snapshot.version);
      const current = matchingUpdateState(get().state, useSettings.getState().settings);
      if (request !== historyRequest) return;
      if (!current || updateHistoryKey(current) !== key) {
        set({ history: null });
        return;
      }
      set({ history: { key, loading: false, data, error: null } });
    } catch (error) {
      const current = matchingUpdateState(get().state, useSettings.getState().settings);
      if (request !== historyRequest) return;
      if (!current || updateHistoryKey(current) !== key) {
        set({ history: null });
        return;
      }
      set({
        history: {
          key,
          loading: false,
          data: previous?.key === key ? previous.data : null,
          error: translateError(error),
        },
      });
    }
  },

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
      const hasDiagnostics = isIpcError(error) && Array.isArray(error.details?.sourceErrors);
      toast(
        hasDiagnostics && error.message === "updates.sourcesUnavailable"
          ? i18n.t("updates.sourcesUnavailableNotification")
          : translateError(error),
        "error",
        hasDiagnostics
          ? {
              label: i18n.t("updates.viewDiagnostics"),
              onClick: () => useWorkspace.getState().openPage("updates"),
            }
          : undefined,
      );
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
