import { create } from "zustand";
import { useMarketplace, boundTo, newerVersion } from "@/store/marketplace";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { api } from "@/lib/api/ipc";
import { supportsManifestVersion } from "@/lib/plugins/activation/compatibility";
import { pluginListSource } from "./source";
import type { PluginListCommand } from "./model";
import { requestMarketInstall } from "../PluginDetailPage";
export const usePluginListDialogs = create<{ request: number }>(() => ({ request: 0 }));
export async function executePluginListCommand(
  command: PluginListCommand,
  showMain?: () => Promise<unknown>,
) {
  if (command.operation === "refresh") {
    await Promise.all([useMarketplace.getState().load(true), usePlugins.getState().load()]);
    return true;
  }
  if (command.operation === "openDirectory") {
    await api.pluginOpenDir();
    return true;
  }
  const resolve = () => ("target" in command ? pluginListSource.resolve(command.target) : null);
  resolve();
  if (showMain) await showMain();
  const current = resolve();
  switch (command.operation) {
    case "settings":
      useNavigation.getState().selectSettings("plugins");
      useWorkspace.getState().openPage("settings");
      return true;
    case "localInstall":
      if (useDialogs.getState().dialog.kind !== "none") throw new Error("dialog.busy");
      usePluginListDialogs.setState((s) => ({ request: s.request + 1 }));
      return true;
    case "open":
      if (!current) throw new Error("pluginSecurity.changed");
      useWorkspace
        .getState()
        .openPluginDetail(current.origin, current.id, (current.entry ?? current.installed)!.name);
      return true;
    case "keep":
      if (!current) throw new Error("pluginSecurity.changed");
      useWorkspace.getState().keepTab(`extension:${current.origin}:${current.id}`);
      return true;
    case "install": {
      const validate = () => {
        const value = resolve();
        if (!value?.entry || !value.source) throw new Error("pluginSecurity.changed");
        const update =
          !!value.installed &&
          boundTo(value.installed, value.source) &&
          newerVersion(value.entry.version, value.installed.version);
        if (
          (value.installed && !update) ||
          !supportsManifestVersion(value.entry.apiVersion) ||
          usePlugins.getState().busyIds.includes(value.id) ||
          useMarketplace.getState().tasks[value.id]
        )
          throw new Error("pluginSecurity.changed");
        return { ...value, entry: value.entry, source: value.source, update };
      };
      if (useDialogs.getState().dialog.kind !== "none") throw new Error("dialog.busy");
      const v = validate();
      requestMarketInstall(v.entry, v.source, v.update, () => {
        validate();
      });
      return true;
    }
  }
}
