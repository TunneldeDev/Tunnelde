import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import type { PluginInfo, MarketEntry } from "@/lib/api/types";
import { pluginFailure } from "@/lib/plugins/errors";
import { toast } from "@/store/toasts";
import { normalizeResult } from "@/lib/plugins/pluginView";
import { useShortcutConflicts } from "@/store/shortcutConflicts";
import i18n from "@/i18n/i18n";

export interface PluginOutput {
  text: string;
  error: boolean;
  title?: string;
}

function notifyPluginFailure(id: string, error: unknown) {
  const name = usePlugins.getState().items.find((item) => item.id === id)?.name ?? id;
  toast(i18n.t("pluginErrors.startFailed", { name, error: pluginFailure(error) }), "error", {
    label: i18n.t("pluginErrors.openLog"),
    onClick: async () => {
      try {
        await api.openLatestLog();
      } catch (cause) {
        toast(translateError(cause), "error");
      }
    },
  });
}

interface PluginsStore {
  items: PluginInfo[];
  busy: string | null;
  busyIds: string[];
  startingIds: string[];
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
  const operations = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; kind: "start" | "stop" | "other" }
  >();
  const installations = new Map<string, Promise<boolean>>();
  const revisions = new Map<string, number>();
  let revision = 0;
  let listRequest = 0;
  let reloadRequest: Promise<void> | null = null;

  const publishOperations = () => {
    const busyIds = [...operations.keys()];
    const startingIds = [...operations]
      .filter(([, operation]) => operation.kind === "start")
      .map(([id]) => id);
    set({ busyIds, busy: busyIds[0] ?? null, startingIds });
  };

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

  // Stop supersedes activation, including consent/setup waits. Other operations
  // remain serialized per plugin, without blocking unrelated plugins.
  const operate = (
    id: string,
    action: (startedAt: number, signal: AbortSignal) => Promise<void>,
    kind: "start" | "stop" | "other" = "other",
  ) => {
    const pending = operations.get(id);
    if (pending) {
      if (kind !== "stop" || pending.kind !== "start") return pending.promise;
      pending.controller.abort();
    }
    const controller = new AbortController();
    const pendingReload = reloadRequest;
    touch(id);
    const request = Promise.resolve().then(async () => {
      try {
        if (pendingReload) await pendingReload;
        if (!controller.signal.aborted) await action(touch(id), controller.signal);
      } finally {
        if (operations.get(id)?.promise === request) {
          operations.delete(id);
          publishOperations();
        }
      }
    });
    operations.set(id, { promise: request, controller, kind });
    publishOperations();
    return request;
  };

  const changeStatus = (
    id: string,
    request: (signal: AbortSignal) => Promise<PluginInfo | null>,
    starting = false,
  ) =>
    operate(
      id,
      async (startedAt, signal) => {
        try {
          const info = await request(signal);
          if (signal.aborted) return;
          // A pushed failure/status event may already be newer than this response.
          if (info && revisions.get(id) === startedAt) get().apply(info);
          const current = get().items.find((item) => item.id === id);
          if (starting && info && current?.status === "failed") {
            notifyPluginFailure(id, new Error(current.error || i18n.t("pluginErrors.unknown")));
          }
        } catch (error) {
          if (signal.aborted) return;
          if (isTauri()) {
            const { reportPluginExecutionFailure } = await import("@/store/pluginSecurity");
            if (signal.aborted) return;
            reportPluginExecutionFailure(error);
          }
          if (starting) notifyPluginFailure(id, error);
          else toast(translateError(error), "error");
        }
      },
      starting ? "start" : "stop",
    );

  return {
    items: [],
    busy: null,
    busyIds: [],
    startingIds: [],
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
      const pending = [...operations.values()].map((operation) => operation.promise);
      const pendingInstalls = [...installations.values()];
      reloadRequest = Promise.resolve()
        .then(async () => {
          await Promise.allSettled([...pending, ...pendingInstalls]);
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
      changeStatus(
        id,
        async (signal) => {
          const info = get().items.find((item) => item.id === id);
          if (info?.runtime === "theme") return null;
          if (isTauri() && info) {
            const { ensurePluginPermission } = await import("@/store/pluginSecurity");
            if (signal.aborted || !(await ensurePluginPermission(info, signal))) return null;
          }
          if (signal.aborted) return null;
          // Native admission captures the current grant before any further wait.
          // A stop invalidates it even if the later start IPC arrives out of order.
          const permit = isTauri()
            ? await api.pluginPrepareStart(id, info?.fingerprint ?? "")
            : null;
          if (signal.aborted) return null;
          if (isTauri() && !["wasm", "declarative", "frontend"].includes(info?.runtime ?? "node")) {
            const { ensureNodeRuntime } = await import("@/features/plugins/NodeRuntimeSection");
            if (signal.aborted || !(await ensureNodeRuntime(signal))) return null;
          }
          if (signal.aborted) return null;
          const started = await api.pluginStart(id, permit);
          if (signal.aborted) return null;
          if (started.frontend && started.status === "running") {
            const { frontendRuntime } = await import("@/lib/extensions/frontendRuntime");
            try {
              await frontendRuntime.ensure(started);
            } catch (error) {
              // The runtime retires failures by lease, never by an unbound ID.
              // Re-read authoritative status while preserving the activation cause.
              if (!signal.aborted) await readList(api.pluginsList);
              throw error;
            }
          }
          return started;
        },
        true,
      ),
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
