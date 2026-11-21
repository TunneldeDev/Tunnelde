import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { samePluginRuntime } from "../commands/runtime";
import { createDeclarativeViewOwner, type DeclarativeViewOwner } from "./declarative";

interface OwnerEntry {
  owner: DeclarativeViewOwner;
  plugin: PluginInfo;
  references: number;
}

export interface DeclarativeViewOwnerLease {
  owner: DeclarativeViewOwner;
  release: () => void;
}

interface Registry {
  entries: Map<string, OwnerEntry>;
  managed: boolean;
  stop: (() => void) | null;
}

let registry: Registry | null = null;
const key = (pluginId: string, viewId: string) => `${pluginId}:${viewId}`;

function current(pluginId: string): PluginInfo {
  const plugin = usePlugins.getState().items.find((item) => item.id === pluginId);
  if (!plugin || plugin.status !== "running") throw new Error("plugin.notRunning");
  return plugin;
}

function retire(entry: OwnerEntry) {
  entry.owner.dispose();
}

function reconcile(active: Registry) {
  for (const [id, entry] of active.entries) {
    const plugin = usePlugins.getState().items.find((item) => item.id === entry.plugin.id);
    if (!samePluginRuntime(plugin, entry.plugin)) {
      active.entries.delete(id);
      retire(entry);
    }
  }
}

function activeRegistry(): Registry {
  registry ??= { entries: new Map(), managed: false, stop: null };
  return registry;
}

/** Acquire a main-owned execution service for one displayed contribution. A
 * coordinator-installed registry retains the owner between body mounts; the
 * unmanaged test/standalone fallback disposes it when the last lease releases. */
export function acquireDeclarativeViewOwner(
  pluginId: string,
  viewId: string,
): DeclarativeViewOwnerLease {
  const active = activeRegistry();
  const id = key(pluginId, viewId);
  const plugin = current(pluginId);
  let entry = active.entries.get(id);
  if (entry && !samePluginRuntime(plugin, entry.plugin)) {
    active.entries.delete(id);
    retire(entry);
    entry = undefined;
  }
  entry ??= {
    owner: createDeclarativeViewOwner(pluginId, viewId),
    plugin,
    references: 0,
  };
  active.entries.set(id, entry);
  entry.references++;
  let released = false;
  return {
    owner: entry.owner,
    release() {
      if (released) return;
      released = true;
      if (entry.references > 0) entry.references--;
      if (!active.managed && entry.references === 0) {
        if (active.entries.get(id) === entry) active.entries.delete(id);
        retire(entry);
      }
    },
  };
}

/** Installed by the main panel coordinator. It retains idle owners for remounts
 * and retires them synchronously when their exact plugin runtime disappears. */
export function installDeclarativeViewOwnerRegistry() {
  if (registry?.managed) throw new Error("plugin.declarativeOwner.alreadyInstalled");
  const active = activeRegistry();
  active.managed = true;
  active.stop = usePlugins.subscribe(() => reconcile(active));
  reconcile(active);
  return () => {
    if (registry !== active || !active.managed) return;
    active.stop?.();
    active.stop = null;
    active.managed = false;
    for (const entry of active.entries.values()) retire(entry);
    active.entries.clear();
    registry = null;
  };
}

/** Test/diagnostic seam only; no caller can inspect the private owner table. */
export function declarativeViewOwnerRegistrySize() {
  return registry?.entries.size ?? 0;
}
