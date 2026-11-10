import type { Host, HostInput } from "@/lib/api/types";

// BEGIN GENERATED HOST SOURCES V1 TYPES
/** Experimental discovery entries contain public metadata only. */
export interface HostSourceEntry {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  tags?: string[];
  note?: string | null;
}
export interface HostSource {
  id: string;
  label: string;
  entries: HostSourceEntry[];
}
export interface HostSourcesSnapshot {
  revision: number;
  items: Array<{
    pluginId: string;
    pluginName: string;
    id: string;
    label: string;
    entries: Array<HostSourceEntry & { hostId: string }>;
  }>;
}
export interface HostSourcesPage extends HostSourcesSnapshot {
  total: number;
  nextOffset: number | null;
}
// END GENERATED HOST SOURCES V1 TYPES

export interface HostSourceReference {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  entryId: string;
}

export function sourceHosts(snapshot: HostSourcesSnapshot): Host[] {
  return snapshot.items.flatMap((source) =>
    source.entries.map((entry) => ({
      id: entry.hostId,
      name: entry.name,
      host: entry.host,
      port: entry.port ?? 22,
      username: entry.username,
      authMethod: "password" as const,
      keyPath: null,
      groupId: null,
      favorite: false,
      color: null,
      tags: [...(entry.tags ?? [])],
      note: entry.note ?? null,
      sortOrder: 0,
      lastUsedAt: null,
      createdAt: 0,
      updatedAt: 0,
      source: {
        pluginId: source.pluginId,
        pluginName: source.pluginName,
        id: source.id,
        label: source.label,
        entryId: entry.id,
      },
    })),
  );
}

/** A user explicitly saves an independent copy; discovery identity is never persisted. */
export function savedHostInput(host: Host): HostInput {
  return {
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    keyPath: host.keyPath,
    groupId: null,
    tags: [...host.tags],
    note: host.note,
    color: host.color,
  };
}
