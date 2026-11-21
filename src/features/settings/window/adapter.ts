import type { SettingsWindowCommand } from "./protocol";
import type { SettingsCall, SettingsOperation, SettingsCalls } from "./protocol";
import type { SettingsProjection } from "./model";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
import { useWindowViews } from "@/lib/panels/windowViews";
import type { createSettingsControlDrafts } from "./drafts";
/** Stable per rendered incarnation. Only read caches may serve a staged tree;
 * mutation/chooser/consent calls always require the exact current live lease. */
export function createSettingsWindowAdapter(
  client: PanelWindowClient,
  record: WindowViewRecord,
  drafts: ReturnType<typeof createSettingsControlDrafts>,
  initial: SettingsProjection,
  password: () => string,
) {
  let projection = initial;
  const listeners = new Set<() => void>();
  const staged = <K extends SettingsOperation>(
    operation: K,
    args: SettingsCalls[K]["args"],
  ): SettingsCalls[K]["result"] => {
    if (
      [
        "sources_load",
        "security_load",
        "node_load",
        "storage_load",
        "profile_load",
        "updateHistory",
      ].includes(operation)
    )
      return undefined as SettingsCalls[K]["result"];
    let value: unknown;
    if (operation === "configuration_get" || operation === "configuration_backups") {
      const [id, fingerprint] = args;
      const plugin = projection.plugins.find(
        (plugin) => plugin.id === id && plugin.fingerprint === fingerprint,
      );
      if (!plugin) throw new Error("pluginSecurity.changed");
      value = drafts.read(
        `configuration:${id}:${fingerprint}:${operation === "configuration_get" ? "snapshot" : "backups"}`,
        undefined,
      );
    } else if (operation === "recovery_owners") value = drafts.read("recovery:owners", undefined);
    else if (operation === "recovery_snapshot")
      value = drafts.read(`recovery:${args[0]}:${args[1]}:snapshot`, undefined);
    else throw new Error("panel.window.staleOwner");
    if (value === undefined || value === null) throw new Error("panel.window.viewNotReady");
    return structuredClone(value) as SettingsCalls[K]["result"];
  };
  const call: SettingsCall = async (operation, ...args) => {
    const current = useWindowViews.getState().entries.get(record.panelId);
    if (
      !current ||
      current.key !== record.key ||
      current.controller !== record.controller ||
      current.failed
    )
      throw new Error("panel.window.staleOwner");
    if (current.staged) return staged(operation, args);
    if (!current.lease || current.moving) throw new Error("panel.window.staleOwner");
    if (operation === "network_saveProfile") {
      await client.control({
        action: "writeSettingsPassword",
        lease: current.lease,
        value: password(),
      });
      const latest = useWindowViews.getState().entries.get(record.panelId);
      if (
        latest?.key !== current.key ||
        latest.controller !== record.controller ||
        latest.staged ||
        latest.moving ||
        latest.failed ||
        latest.lease !== current.lease
      )
        throw new Error("panel.window.staleOwner");
    }
    return client.action(current.lease, {
      kind: "settings",
      command: { operation, args } as SettingsWindowCommand,
    });
  };
  return {
    call,
    current: () => projection,
    subscribe(changed: () => void) {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    publish(next: SettingsProjection) {
      projection = next;
      for (const changed of listeners) changed();
    },
  };
}
