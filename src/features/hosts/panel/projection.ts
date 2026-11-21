import type { Group, Host, Settings } from "@/lib/api/types";
import type { DisplayHostColumn } from "@/lib/hosts/columns";
import type { OwnedHostDecoration } from "@/lib/plugins/hostList";
import type { PluginContextCommand } from "@/lib/plugins/contextCommand";
import type { HostPanelTarget } from "./protocol";

export interface HostPanelData {
  hosts: Host[];
  groups: Group[];
  hostTargets: Record<string, HostPanelTarget>;
  groupTargets: Record<string, HostPanelTarget>;
  columns: Array<
    Omit<DisplayHostColumn, "values"> & {
      values: Array<[string, { value: string | number | boolean; tooltip?: string }]>;
    }
  >;
  decorations: Array<[string, OwnedHostDecoration[]]>;
  commands: PluginContextCommand[];
  preferences: Settings["hostList"];
  activation: Settings["hostActivation"];
  activeHostId: string | null;
  connecting: string[];
  platform: string;
}
/** Explicit projection: host display metadata only. Never spread future store
 * fields (credentials, credential references or connection routes) into IPC. */
export function projectHost(host: Host): Host {
  return {
    id: host.id,
    name: host.name,
    groupId: host.groupId,
    host: host.host,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    keyPath: host.keyPath,
    favorite: host.favorite,
    color: host.color,
    tags: [...host.tags],
    note: host.note,
    sortOrder: host.sortOrder,
    lastUsedAt: host.lastUsedAt,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
    ...(host.source
      ? {
          source: {
            pluginId: host.source.pluginId,
            pluginName: host.source.pluginName,
            id: host.source.id,
            entryId: host.source.entryId,
            label: host.source.label,
          },
        }
      : {}),
  };
}
/** Revisions are opaque incarnation markers, not authority or serialized host
 * hashes. Deleted/replaced/edited targets cannot be revived by stale menus. */
export function createHostTargetIndex() {
  const entries = new Map<string, { value: string; revision: string }>();
  return (items: readonly (Host | Group)[]): Record<string, HostPanelTarget> => {
    const ids = new Set(items.map((item) => item.id));
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
    return Object.fromEntries(
      items.map((item) => {
        const value = JSON.stringify(item);
        let entry = entries.get(item.id);
        if (!entry || entry.value !== value) {
          entry = { value, revision: crypto.randomUUID() };
          entries.set(item.id, entry);
        }
        return [item.id, { id: item.id, revision: entry.revision }];
      }),
    );
  };
}
