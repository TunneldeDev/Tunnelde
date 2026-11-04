import { create } from "zustand";

import { api, events, isTauri } from "@/lib/api/ipc";
import type {
  MarketCatalogue,
  MarketEntry,
  MarketSource,
  PluginConfig,
  PluginDownload,
  PluginInfo,
} from "@/lib/api/types";
import { MARKETPLACE_INDEX_URL, fetchMarketplace } from "@/lib/plugins/marketplace";
import { translateError } from "@/lib/api/errors";
import { usePlugins } from "@/store/plugins";
import { toast } from "@/store/toasts";

export const OFFICIAL_SOURCE: MarketSource = {
  id: "official",
  name: "Tunnelde",
  url: MARKETPLACE_INDEX_URL,
  enabled: true,
};

export function newerVersion(candidate: string, installed: string): boolean {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(version);
    return match
      ? {
          parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
          pre: match[4]?.split(".") ?? [],
        }
      : null;
  };
  const a = parse(candidate),
    b = parse(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; ++i) if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!;
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !!b.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); ++i) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === undefined || y === undefined) return x !== undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    return xn && yn ? Number(x) > Number(y) : xn !== yn ? !xn : x > y;
  }
  return false;
}

export function boundTo(plugin: PluginInfo, source: MarketSource): boolean {
  return plugin.sourceId === source.id && plugin.sourceUrl === source.url;
}

interface MarketplaceStore {
  config: PluginConfig;
  ready: boolean;
  configError: string | null;
  configLoading: boolean;
  catalogues: Record<string, MarketCatalogue>;
  errors: Record<string, string>;
  loading: string[];
  tasks: Record<string, PluginDownload>;
  cancelling: string[];
  taskErrors: Record<string, string>;
  query: string;
  tag: string;
  page: number;
  setTag: (tag: string) => void;
  setPage: (page: number) => void;
  scope: "installed" | "market" | "updates";
  selected: string | null;
  setQuery: (value: string) => void;
  setScope: (value: MarketplaceStore["scope"]) => void;
  select: (value: string) => void;
  load: (refresh?: boolean) => Promise<void>;
  saveSources: (sources: MarketSource[]) => Promise<void>;
  install: (entry: MarketEntry, source: MarketSource, update: boolean) => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

export const useMarketplace = create<MarketplaceStore>((set, get) => {
  let configRequest: Promise<void> | null = null;
  const loads = new Map<string, { source: MarketSource; request: Promise<void> }>();
  const installs = new Map<string, Promise<void>>();
  const cancelled = new Set<string>();
  const started = new Set<string>();
  let configRevision = 0;
  let configListening = false;
  let downloadListening = false;
  let listenerRequest: Promise<void> | null = null;
  const activeLoads = (config: PluginConfig) => [
    ...new Set(
      [...loads.values()]
        .filter(({ source }) =>
          config.sources.some((s) => s.id === source.id && s.url === source.url && s.enabled),
        )
        .map(({ source }) => source.id),
    ),
  ];
  const applyConfig = (config: PluginConfig) => {
    configRevision++;
    set((state) => ({
      config,
      ready: true,
      configError: null,
      catalogues: Object.fromEntries(
        Object.entries(state.catalogues).filter(([id, value]) =>
          config.sources.some((s) => s.id === id && s.url === value.source.url),
        ),
      ),
      errors: {},
      loading: activeLoads(config),
    }));
  };
  const ensureListeners = () => {
    if (!isTauri() || (configListening && downloadListening)) return Promise.resolve();
    if (listenerRequest) return listenerRequest;
    listenerRequest = Promise.resolve()
      .then(async () => {
        const listeners = await Promise.allSettled([
          configListening
            ? Promise.resolve()
            : events
                .onPluginConfig((next) => {
                  applyConfig(next);
                  void get().load();
                })
                .then(() => {
                  configListening = true;
                }),
          downloadListening
            ? Promise.resolve()
            : events
                .onPluginDownload((payload) =>
                  set((state) => {
                    const owner = Object.entries(state.tasks).find(
                      ([, task]) => task.taskId === payload.taskId,
                    )?.[0];
                    return owner ? { tasks: { ...state.tasks, [owner]: payload } } : state;
                  }),
                )
                .then(() => {
                  downloadListening = true;
                }),
        ]);
        const failed = listeners.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })
      .finally(() => {
        listenerRequest = null;
      });
    return listenerRequest;
  };
  const config = async () => {
    await ensureListeners().catch(() => undefined);
    if (get().ready) return;
    if (configRequest) return configRequest;
    const revision = configRevision;
    set({ configLoading: true, configError: null });
    configRequest = Promise.resolve().then(async () => {
      try {
        const next = isTauri()
          ? await api.pluginConfig()
          : { sources: [OFFICIAL_SOURCE], nodePath: null, nodeSystemAllowed: false };
        if (configRevision === revision) applyConfig(next);
      } catch (error) {
        if (configRevision === revision) set({ configError: translateError(error) });
      } finally {
        configRequest = null;
        set({ configLoading: false });
      }
    });
    await configRequest;
  };
  const loadSource = (source: MarketSource, refresh: boolean) => {
    const key = `${source.id}:${source.url}`;
    const pending = loads.get(key);
    if (pending) return pending.request;
    const request = Promise.resolve().then(async () => {
      try {
        const catalogue = isTauri()
          ? await api.marketplaceCatalogue(source.id, refresh)
          : {
              source,
              entries: await fetchMarketplace(),
              checkedAt: Date.now(),
              stale: false,
              error: null,
            };
        if (
          catalogue.source.id !== source.id ||
          catalogue.source.url !== source.url ||
          !get().config.sources.some((s) => s.id === source.id && s.url === source.url && s.enabled)
        )
          return;
        set((state) => ({
          catalogues: { ...state.catalogues, [source.id]: catalogue },
          errors: Object.fromEntries(
            Object.entries(state.errors).filter(([id]) => id !== source.id),
          ),
        }));
      } catch (error) {
        if (get().config.sources.some((s) => s.id === source.id && s.url === source.url))
          set((state) => ({ errors: { ...state.errors, [source.id]: translateError(error) } }));
      } finally {
        loads.delete(key);
        set({ loading: activeLoads(get().config) });
      }
    });
    loads.set(key, { source, request });
    set({ loading: activeLoads(get().config) });
    return request;
  };
  return {
    config: { sources: [OFFICIAL_SOURCE], nodePath: null, nodeSystemAllowed: false },
    ready: false,
    configError: null,
    configLoading: false,
    catalogues: {},
    errors: {},
    loading: [],
    tasks: {},
    cancelling: [],
    taskErrors: {},
    query: "",
    scope: "market",
    selected: null,
    setQuery: (query) => set({ query, page: 0 }),
    tag: "",
    page: 0,
    setTag: (tag) => set({ tag, page: 0 }),
    setPage: (page) => set({ page: Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0 }),
    setScope: (scope) => set({ scope, page: 0 }),
    select: (selected) => set({ selected }),
    load: async (refresh = false) => {
      await config();
      if (!get().ready) return;
      await Promise.allSettled(
        get()
          .config.sources.filter((s) => s.enabled)
          .map((s) => loadSource(s, refresh)),
      );
    },
    saveSources: async (sources) => {
      const revision = configRevision;
      const next = await api.pluginSourcesSave(sources);
      if (configRevision === revision || JSON.stringify(get().config) === JSON.stringify(next))
        applyConfig(next);
      void get().load(true);
    },
    install: (entry, source, update) => {
      const pending = installs.get(entry.id);
      if (pending) return pending;
      const taskId = `plugin-${entry.id}-${crypto.randomUUID()}`;
      set((state) => ({
        taskErrors: Object.fromEntries(
          Object.entries(state.taskErrors).filter(([id]) => id !== entry.id),
        ),
        tasks: {
          ...state.tasks,
          [entry.id]: { taskId, phase: "connecting", received: 0, total: null },
        },
      }));
      const request = Promise.resolve().then(async () => {
        try {
          await config();
          await ensureListeners();
          if (cancelled.has(taskId)) return;
          const currentSource = get().config.sources.find((s) => s.id === source.id && s.enabled);
          if (!currentSource) throw { code: "validation", message: "market.sourceDisabled" };
          if (currentSource.url !== source.url)
            throw { code: "validation", message: "market.sourceMismatch" };
          const currentPlugin = usePlugins
            .getState()
            .items.find((plugin) => plugin.id === entry.id);
          if (currentPlugin && !boundTo(currentPlugin, currentSource))
            throw { code: "validation", message: "market.sourceConflict" };
          started.add(taskId);
          await usePlugins.getState().installMarket(entry, source.id, taskId, update, (error) => {
            const isCancelled =
              typeof error === "object" &&
              error !== null &&
              "message" in error &&
              error.message === "market.cancelled";
            if (!isCancelled)
              set((state) => ({
                taskErrors: { ...state.taskErrors, [entry.id]: translateError(error) },
              }));
          });
        } catch (error) {
          const message = translateError(error);
          set((state) => ({ taskErrors: { ...state.taskErrors, [entry.id]: message } }));
          toast(message, "error");
        } finally {
          cancelled.delete(taskId);
          started.delete(taskId);
          installs.delete(entry.id);
          set((state) => ({
            cancelling: state.cancelling.filter((id) => id !== entry.id),
            tasks: Object.fromEntries(
              Object.entries(state.tasks).filter(([id]) => id !== entry.id),
            ),
          }));
        }
      });
      installs.set(entry.id, request);
      return request;
    },
    cancel: async (id) => {
      const task = get().tasks[id];
      if (!task || get().cancelling.includes(id)) return;
      cancelled.add(task.taskId);
      set((state) => ({ cancelling: [...state.cancelling, id] }));
      if (!started.has(task.taskId)) return;
      try {
        await api.downloadCancel(task.taskId);
      } catch (error) {
        if (get().tasks[id]?.taskId !== task.taskId) return;
        cancelled.delete(task.taskId);
        const message = translateError(error);
        set((state) => ({
          cancelling: state.cancelling.filter((value) => value !== id),
          taskErrors: { ...state.taskErrors, [id]: message },
        }));
        toast(message, "error");
      }
    },
  };
});
