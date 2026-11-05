import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import type { PluginInfo, MarketEntry } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { normalizeResult } from "@/lib/plugins/pluginView";
import { useShortcutConflicts } from "@/store/shortcutConflicts";
import i18n from "@/i18n/i18n";

export interface PluginOutput {
  text: string;
  error: boolean;
  title?: string;
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
  installMarket: (
    entry: MarketEntry,
    sourceId: string,
    taskId: string,
    update: boolean,
    onError?: (error: unknown) => void,
  ) => Promise<boolean>;
  uninstall: (id: string) => Promise<void>;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  run: (id: string, command: string) => Promise<void>;
  execute: (id: string, command: string, input: () => Record<string, unknown>) => Promise<unknown>;
  clearOutput: (id: string) => void;
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
            ...items.flatMap((item) => {
              if (!changed(item.id)) return [item];
              const latest = current.get(item.id);
              return latest ? [latest] : [];
            }),
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

  const changeStatus = (id: string, request: () => Promise<PluginInfo | null>) =>
    operate(id, async (startedAt) => {
      try {
        const info = await request();
        // A pushed failure/status event may already be newer than this response.
        if (info && revisions.get(id) === startedAt) get().apply(info);
      } catch (error) {
        if (isTauri()) {
          const { reportPluginExecutionFailure } = await import("@/store/pluginSecurity");
          reportPluginExecutionFailure(error);
        }
        toast(translateError(error), "error");
      }
    });

  return {
    items: [],
    busy: null,
    busyIds: [],
    reloading: false,
    outputs: {},
    clearOutput: (id) =>
      set((state) => ({
        outputs: Object.fromEntries(Object.entries(state.outputs).filter(([key]) => key !== id)),
      })),

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
            const before = get().items;
            const info = await api.pluginInstall(path);
            const previous = before.find((item) => item.id === info.id);
            get().apply(info);
            useShortcutConflicts.getState().enqueue(previous, info, get().items);
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

    start: (id) =>
      changeStatus(id, async () => {
        const info = get().items.find((item) => item.id === id);
        if (info?.runtime === "theme") return null;
        if (isTauri() && info) {
          const { ensurePluginPermission } = await import("@/store/pluginSecurity");
          if (!(await ensurePluginPermission(info))) return null;
        }
        if (isTauri() && !["wasm", "declarative"].includes(info?.runtime ?? "node")) {
          const { ensureNodeRuntime } = await import("@/features/plugins/NodeRuntimeSection");
          if (!(await ensureNodeRuntime())) return null;
        }
        return api.pluginStart(id);
      }),
    stop: (id) => changeStatus(id, () => api.pluginStop(id)),

    installMarket: async (entry, sourceId, taskId, update, onError) => {
      let success = false;
      await operate(entry.id, async () => {
        try {
          const previous = get().items.find((item) => item.id === entry.id);
          const info = await api.marketplaceDownload(
            sourceId,
            entry.id,
            entry.version,
            entry.sha256,
            taskId,
            update,
          );
          get().apply(info);
          useShortcutConflicts.getState().enqueue(previous, info, get().items);
          success = true;
        } catch (error) {
          onError?.(error);
          if (!(
            typeof error === "object" &&
            error !== null &&
            "message" in error &&
            error.message === "market.cancelled"
          ))
            toast(translateError(error), "error");
        }
      });
      return success;
    },

    uninstall: (id) =>
      operate(id, async () => {
        try {
          await api.pluginUninstall(id);
          touch(id);
          set((state) => ({
            items: state.items.filter((item) => item.id !== id),
            outputs: Object.fromEntries(
              Object.entries(state.outputs).filter(([key]) => key !== id),
            ),
          }));
        } catch (error) {
          toast(translateError(error), "error");
        }
      }),

    execute: async (id, command, input) => {
      if (operations.has(id)) throw new Error("plugin.api.busy");
      let result: unknown;
      await operate(id, async () => {
        const info = get().items.find((item) => item.id === id);
        if (!info || info.status !== "running") throw new Error("plugin.notRunning");
        if (isTauri()) {
          const { ensurePluginPermission } = await import("@/store/pluginSecurity");
          if (!(await ensurePluginPermission(info))) throw new Error("plugin.permissionDenied");
        }
        const current = get().items.find((item) => item.id === id);
        if (!current || current.status !== "running" || current.fingerprint !== info.fingerprint) {
          throw new Error(i18n.t("pluginSecurity.changed"));
        }
        // Build editor input only after consent, so callers can reject stale snapshots.
        result = await api.pluginRun(id, command, input());
      });
      return result;
    },

    run: (id, command) =>
      operate(id, async () => {
        let output: PluginOutput;
        try {
          const info = get().items.find((item) => item.id === id);
          if (isTauri() && info) {
            const { ensurePluginPermission } = await import("@/store/pluginSecurity");
            if (!(await ensurePluginPermission(info))) return;
          }
          const result = await api.pluginRun(id, command, {
            _locale: i18n.resolvedLanguage ?? i18n.language,
          });
          output = normalizeResult(result);
        } catch (error) {
          if (isTauri()) {
            const { reportPluginExecutionFailure } = await import("@/store/pluginSecurity");
            reportPluginExecutionFailure(error);
          }
          output = {
            text:
              error instanceof Error && error.message === "resultTooLarge"
                ? i18n.t("pluginView.resultTooLarge")
                : translateError(error),
            error: true,
          };
        }
        set((state) => ({ outputs: { ...state.outputs, [id]: output } }));
      }),
  };
});
