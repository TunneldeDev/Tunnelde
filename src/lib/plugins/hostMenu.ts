import type { Host, PluginInfo } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";
import i18n from "@/i18n/i18n";
import { runPluginContextCommand, type PluginContextCommand } from "./contextCommand";

// BEGIN GENERATED HOST MENU V1 TYPES
/** Experimental, advisory context. No credentials, key paths or internal store fields. */
export interface HostMenuCommandInput {
  host: {
    id: string;
    name: string;
    address: string;
    port: number;
    username: string;
    groupId: string | null;
    tags: string[];
  };
}
// END GENERATED HOST MENU V1 TYPES

export const HOST_MENU_PER_PLUGIN = 16;
export const HOST_MENU_TOTAL = 128;

export function hostMenuCommands(plugins: readonly PluginInfo[]): PluginContextCommand[] {
  const actions: PluginContextCommand[] = [];
  // Stable ordering across native snapshots; a plugin cannot replace built-in actions.
  const sorted = [...plugins].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const plugin of sorted) {
    if (
      plugin.runtime === "theme" ||
      plugin.runtime === "declarative" ||
      !plugin.permissions.includes("hosts.read")
    )
      continue;
    for (const command of plugin.commands
      .filter((entry) => entry.hostMenu)
      .slice(0, HOST_MENU_PER_PLUGIN)) {
      if (actions.length >= HOST_MENU_TOTAL) return actions;
      actions.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        command: command.id,
        title: command.title,
        fingerprint: plugin.fingerprint,
        first: actions.length === 0,
      });
    }
  }
  return actions;
}

export function hostMenuInput(host: Host): HostMenuCommandInput {
  return {
    host: {
      id: host.id,
      name: host.name,
      address: host.host,
      port: host.port,
      username: host.username,
      groupId: host.groupId,
      tags: [...host.tags],
    },
  };
}

/** Keep the selected host independent of focus changes and reject edits during consent. */
export function runHostMenuCommand(
  action: PluginContextCommand,
  host: Host,
  signal?: AbortSignal,
): Promise<void> {
  const selected = hostMenuInput(host);
  return runPluginContextCommand(
    action,
    {
      accepts: (plugin) =>
        hostMenuCommands([plugin]).some((item) => item.command === action.command),
      validate: () => {
        const latest = useHosts.getState().hosts.find((item) => item.id === host.id);
        if (!latest || JSON.stringify(hostMenuInput(latest)) !== JSON.stringify(selected))
          throw new Error(i18n.t("pluginView.hostChanged"));
      },
      input: () => ({ ...selected }),
    },
    signal,
  );
}
