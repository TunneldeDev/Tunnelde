import { useMarketplace } from "@/store/marketplace";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import type { MarketEntry, MarketSource, PluginInfo } from "@/lib/api/types";
import { pluginListKey, type PluginBrowserData, type PluginListTarget } from "./model";
interface Resolved {
  origin: string;
  id: string;
  entry?: MarketEntry;
  source?: MarketSource;
  installed?: PluginInfo;
}
export function createPluginListSource() {
  let inputs: unknown[] = [],
    cached: PluginBrowserData | undefined;
  const targets = new Map<
    string,
    { value: string; target: PluginListTarget; resolved: Resolved }
  >();
  function snapshot(): PluginBrowserData {
    const m = useMarketplace.getState(),
      p = usePlugins.getState(),
      w = useWorkspace.getState();
    const next = [
      m.config,
      m.catalogues,
      m.errors,
      m.loading,
      m.ready,
      m.configError,
      m.configLoading,
      p.items,
      p.busyIds,
      m.tasks,
      w.activeId,
    ];
    if (cached && next.every((v, i) => v === inputs[i])) return cached;
    inputs = next;
    const live = new Set<string>();
    const register = (resolved: Resolved) => {
      const id = pluginListKey(resolved.origin, resolved.id);
      live.add(id);
      const value = JSON.stringify(resolved);
      let old = targets.get(id);
      if (!old || old.value !== value) {
        old = { value, target: { id, revision: crypto.randomUUID() }, resolved };
        targets.set(id, old);
      }
      return old.target;
    };
    const metadata = (info: MarketEntry | PluginInfo) => ({
      id: info.id,
      name: info.name,
      version: info.version,
      description: info.description,
      ...(info.author !== undefined ? { author: info.author } : {}),
      ...(info.tags ? { tags: [...info.tags] } : {}),
      ...(info.runtime !== undefined ? { runtime: info.runtime } : {}),
      ...(info.apiVersion !== undefined ? { apiVersion: info.apiVersion } : {}),
    });
    const modelTargets: PluginBrowserData["targets"] = {};
    const items = p.items.map((info) => {
      const key = pluginListKey("local", info.id);
      modelTargets[key] = register({ origin: "local", id: info.id, installed: info });
      return {
        ...metadata(info),
        apiVersion: info.apiVersion,
        path: info.path,
        ...(info.sourceId !== undefined ? { sourceId: info.sourceId } : {}),
        ...(info.sourceUrl !== undefined ? { sourceUrl: info.sourceUrl } : {}),
      };
    });
    const sources = m.config.sources.map(({ id, name, url, enabled }) => ({
      id,
      name,
      url,
      enabled,
    }));
    const catalogues = Object.fromEntries(
      sources
        .filter((s) => s.enabled)
        .flatMap((source) => {
          const cat = m.catalogues[source.id];
          if (!cat || cat.source.url !== source.url) return [];
          return [
            [
              source.id,
              {
                stale: cat.stale,
                checkedAt: cat.checkedAt,
                entries: cat.entries.map((entry) => {
                  modelTargets[pluginListKey(source.id, entry.id)] = register({
                    origin: source.id,
                    id: entry.id,
                    entry,
                    source,
                    installed: p.items.find((x) => x.id === entry.id),
                  });
                  return metadata(entry);
                }),
              },
            ],
          ];
        }),
    );
    for (const key of targets.keys()) if (!live.has(key)) targets.delete(key);
    return (cached = {
      config: { sources },
      catalogues,
      errors: { ...m.errors },
      loading: [...m.loading],
      ready: m.ready,
      configError: m.configError,
      configLoading: m.configLoading,
      items,
      busyIds: [...p.busyIds],
      tasks: Object.fromEntries(Object.keys(m.tasks).map((id) => [id, true])),
      active: w.activeId,
      targets: modelTargets,
    });
  }
  return {
    snapshot,
    resolve(target: PluginListTarget) {
      snapshot();
      const entry = targets.get(target.id);
      if (!entry || entry.target.revision !== target.revision)
        throw new Error("pluginSecurity.changed");
      return entry.resolved;
    },
    subscribe(notify: () => void) {
      const changed = () => {
        snapshot();
        notify();
      };
      const stops = [
        useMarketplace.subscribe(changed),
        usePlugins.subscribe(changed),
        useWorkspace.subscribe(changed),
      ];
      return () => stops.forEach((stop) => stop());
    },
  };
}
export const pluginListSource = createPluginListSource();
