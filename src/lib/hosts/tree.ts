import type { Group, Host } from "@/lib/api/types";
import { matchesHostQuery, parseHostQuery } from "@/lib/hosts/query";

export interface HostGroupNode {
  group: Group;
  hosts: Host[];
  children: HostGroupNode[];
  count: number;
}

export function buildHostTree(groups: Group[], hosts: Host[], query: string) {
  const filter = parseHostQuery(query);
  const visible = hosts.filter((host) => matchesHostQuery(host, filter));
  const rest = visible.filter((host) => !host.favorite && !host.source);
  const sources = new Map<string, HostGroupNode>();
  for (const host of visible) {
    if (!host.source) continue;
    const key = JSON.stringify([host.source.pluginId, host.source.id]);
    let node = sources.get(key);
    if (!node) {
      node = {
        group: {
          id: `source-group:${key}`,
          name: `${host.source.label} · ${host.source.pluginName}`,
          parentId: null,
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
        },
        hosts: [],
        children: [],
        count: 0,
      };
      sources.set(key, node);
    }
    node.hosts.push(host);
    node.count++;
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const byGroup = new Map<string, Host[]>();
  const byParent = new Map<string, Group[]>();
  for (const host of rest) {
    if (!host.groupId) continue;
    const bucket = byGroup.get(host.groupId) ?? [];
    bucket.push(host);
    byGroup.set(host.groupId, bucket);
  }
  for (const group of groups) {
    if (!group.parentId) continue;
    const bucket = byParent.get(group.parentId) ?? [];
    bucket.push(group);
    byParent.set(group.parentId, bucket);
  }

  const visited = new Set<string>();
  const visit = (group: Group): HostGroupNode | null => {
    if (visited.has(group.id)) return null;
    visited.add(group.id);
    const children = (byParent.get(group.id) ?? [])
      .map(visit)
      .filter((child): child is HostGroupNode => child !== null);
    const members = byGroup.get(group.id) ?? [];
    const count = members.length + children.reduce((sum, child) => sum + child.count, 0);
    return query && count === 0 ? null : { group, hosts: members, children, count };
  };
  const tree: HostGroupNode[] = [];
  const add = (group: Group) => {
    const node = visit(group);
    if (node) tree.push(node);
  };
  groups.filter((group) => !group.parentId || !groupIds.has(group.parentId)).forEach(add);
  // Recover imported orphan/cyclic hierarchies without hiding hosts or mutating saved groups.
  groups.filter((group) => !visited.has(group.id)).forEach(add);

  return {
    sources: [...sources.values()],
    favorites: visible.filter((host) => host.favorite && !host.source),
    ungrouped: rest.filter((host) => !host.groupId || !groupIds.has(host.groupId)),
    groups: tree,
  };
}
