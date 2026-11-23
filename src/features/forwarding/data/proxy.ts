import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/api/ipc";
import type {
  ProxyConnection,
  ProxyGroup,
  ProxyGroupInput,
  ProxyRoute,
  ProxyRuntime,
} from "../model/proxy";

const empty = <T,>(): Promise<T[]> => Promise.resolve([]);
export const proxyApi = Object.freeze({
  groups: (hostId: string) =>
    isTauri()
      ? invoke<ProxyGroup[]>("proxy_groups_list", { hostId })
      : empty<ProxyGroup>(),
  saveGroup: (group: ProxyGroupInput, expectedRevision?: string) =>
    invoke<ProxyGroup>("proxy_group_save", { group, expectedRevision }),
  removeGroup: (id: string, expectedRevision: string) =>
    invoke<void>("proxy_group_remove", { id, expectedRevision }),
  routes: (groupId: string) =>
    isTauri() ? invoke<ProxyRoute[]>("proxy_routes_list", { groupId }) : empty<ProxyRoute>(),
  saveRoute: (route: Omit<ProxyRoute, "revision">, expectedRevision?: string) =>
    invoke<ProxyRoute>("proxy_route_save", { route, expectedRevision }),
  removeRoute: (id: string, expectedRevision: string) =>
    invoke<void>("proxy_route_remove", { id, expectedRevision }),
  runtime: () => (isTauri() ? invoke<ProxyRuntime[]>("proxy_runtime_list") : empty<ProxyRuntime>()),
  start: (groupId: string, expectedRevision: string) =>
    invoke<ProxyRuntime>("proxy_runtime_start", { groupId, expectedRevision }),
  stop: (groupId: string, expectedRevision: string, runtimeId?: string | null) =>
    invoke<void>("proxy_runtime_stop", { groupId, expectedRevision, runtimeId }),
  connections: (groupId: string) =>
    isTauri()
      ? invoke<ProxyConnection[]>("proxy_connections_list", { groupId })
      : empty<ProxyConnection>(),
  closeConnection: (id: string) => invoke<void>("proxy_connection_close", { id }),
});
