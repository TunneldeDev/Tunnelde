import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useHostColumns } from "@/store/hostColumns";
import { useHostDecorations } from "@/store/hostDecorations";
import { usePlugins } from "@/store/plugins";
import { hostMenuCommands } from "@/lib/plugins/hostMenu";
import { createHostTargetIndex, projectHost, type HostPanelData } from "./projection";

export function createHostPanelSource() {
  const hosts = createHostTargetIndex(),
    groups = createHostTargetIndex();
  let inputs: unknown[] = [],
    cached: HostPanelData | undefined;
  return {
    snapshot(): HostPanelData {
      const h = useHosts.getState(),
        s = useSettings.getState(),
        w = useWorkspace.getState();
      const tab = w.tabs.find((item) => item.id === w.activeId);
      const activeHostId = tab?.kind === "host" ? tab.hostId : null;
      const columns = useHostColumns.getState().columns;
      const decorations = useHostDecorations.getState().byHost;
      const plugins = usePlugins.getState().items;
      const connecting = useSsh.getState().connectingHostIds;
      const next = [
        h.hosts,
        h.groups,
        s.settings.hostList,
        s.settings.hostActivation,
        s.info?.os,
        activeHostId,
        columns,
        decorations,
        plugins,
        connecting,
      ];
      if (cached && next.every((value, index) => value === inputs[index])) return cached;
      inputs = next;
      const projected = h.hosts.map(projectHost);
      const projectedGroups = h.groups.map(
        ({ id, name, parentId, sortOrder, createdAt, updatedAt }) => ({
          id,
          name,
          parentId,
          sortOrder,
          createdAt,
          updatedAt,
        }),
      );
      return (cached = {
        hosts: projected,
        groups: projectedGroups,
        hostTargets: hosts(projected),
        groupTargets: groups(projectedGroups),
        columns: columns.map(({ key, label, source, width, type, values }) => ({
          key,
          label,
          ...(source ? { source } : {}),
          width,
          type,
          values: [...values],
        })),
        decorations: [...decorations],
        commands: hostMenuCommands(plugins),
        preferences: s.settings.hostList,
        activation: s.settings.hostActivation,
        activeHostId,
        connecting,
        platform: s.info?.os ?? "",
      });
    },
    subscribe(notify: () => void) {
      // Read every publication so deletion/recreation rotates target identity,
      // even if React batches the intermediate snapshot away.
      const changed = () => {
        this.snapshot();
        notify();
      };
      const stops = [
        useHosts.subscribe(changed),
        useSettings.subscribe(changed),
        useWorkspace.subscribe(changed),
        useSsh.subscribe(changed),
        useHostColumns.subscribe(changed),
        useHostDecorations.subscribe(changed),
        usePlugins.subscribe(changed),
      ];
      return () => stops.forEach((stop) => stop());
    },
  };
}
export const hostPanelSource = createHostPanelSource();
