import { create } from "zustand";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { useHosts } from "@/store/hosts";
import type { PanelLease, NativePanelSnapshot } from "@/lib/panels/windowProtocol";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
export const useHostDetailRegistrations = create<{ entries: ReadonlyMap<string, string> }>(() => ({
  entries: new Map(),
}));
export function hostDetailIds() {
  const tabs = useWorkspace.getState().tabs.filter((t) => t.kind === "host" && t.hostId);
  const old = useHostDetailRegistrations.getState().entries,
    entries = new Map(old);
  for (const tab of tabs)
    if (!entries.has(tab.id)) entries.set(tab.id, `host-view:${crypto.randomUUID()}`);
  for (const id of entries.keys()) if (!tabs.some((t) => t.id === id)) entries.delete(id);
  if (entries.size !== old.size || [...entries].some(([id, v]) => old.get(id) !== v))
    useHostDetailRegistrations.setState({ entries });
  return [...entries.values()];
}
export const hostDetailTabId = (panelId: string) =>
  [...useHostDetailRegistrations.getState().entries].find(([, v]) => v === panelId)?.[0];
export function hostDetailAllowsMove(hostId: string) {
  const host = useHosts.getState().hosts.find((h) => h.id === hostId);
  if (!host) return true; // deleted hosts retain a transferable empty state
  if (useSettings.getState().settings.uiProviders.forwarding && !host.source) return false;
  // Legacy host-contribution drafts have no capture contract yet. Never silently
  // drop them or replay singleton plugin activation in another document.
  return (
    !!host.source || !usePlugins.getState().items.some((p) => p.hostFields || p.hostDetails?.length)
  );
}
export async function bindHostDetail(client: PanelWindowClient, panelId: string) {
  const tabId = hostDetailTabId(panelId);
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId && t.kind === "host");
  if (!tab?.hostId) throw new Error("panel.window.staleOwner");
  return client.control<PanelLease>({
    action: "bindHostPage",
    panelId,
    hostId: tab.hostId,
    allowMove: hostDetailAllowsMove(tab.hostId),
  });
}
export async function synchronizeHostDetails(
  client: PanelWindowClient,
  snapshot: NativePanelSnapshot,
) {
  for (const descriptor of snapshot.hostPages ?? []) {
    const tab = useWorkspace
      .getState()
      .tabs.find((t) => t.id === hostDetailTabId(descriptor.panelId));
    if (tab?.hostId && descriptor.allowMove !== hostDetailAllowsMove(tab.hostId)) {
      try {
        await bindHostDetail(client, descriptor.panelId);
      } catch (error) {
        if (!String((error as Error)?.message ?? error).includes("panel interaction in progress"))
          throw error;
      }
    }
  }
}
