import { usePlugins } from "@/store/plugins";
import { selectedUiProvider } from "@/lib/extensions/providers";
import type { NativePanelSnapshot } from "@/lib/panels/windowProtocol";
import { create } from "zustand";
import { useWorkspace } from "@/store/workspace";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { useSettings } from "@/store/settings";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
export const useSettingsRegistrations = create<{ entries: ReadonlyMap<string, string> }>(() => ({
  entries: new Map(),
}));
export function settingsWindowIds() {
  const tabs = useWorkspace
    .getState()
    .tabs.filter((tab) => tab.kind === "settings" || tab.kind === "updates");
  const previous = useSettingsRegistrations.getState().entries,
    entries = new Map(previous);
  for (const tab of tabs)
    if (!entries.has(tab.id)) entries.set(tab.id, `settings-view:${crypto.randomUUID()}`);
  for (const id of entries.keys()) if (!tabs.some((tab) => tab.id === id)) entries.delete(id);
  if (
    entries.size !== previous.size ||
    [...entries].some(([key, value]) => previous.get(key) !== value)
  )
    useSettingsRegistrations.setState({ entries });
  return [...entries.values()];
}
export const settingsWindowTabId = (panelId: string) =>
  [...useSettingsRegistrations.getState().entries].find(([, id]) => id === panelId)?.[0];
export function settingsAllowsMove() {
  const selected = useSettings.getState().settings.uiProviders.preferences;
  const provider = selectedUiProvider(
    usePlugins.getState().items,
    useSettings.getState().settings.uiProviders,
    "preferences",
  );
  return (
    !selected ||
    (!!provider &&
      provider.view.allowFloating !== false &&
      !!frontendRuntime.factoryOwner(selected.pluginId, selected.viewId))
  );
}
export async function bindSettingsWindow(client: PanelWindowClient, panelId: string) {
  if (!settingsWindowTabId(panelId)) throw new Error("panel.window.staleOwner");
  return client.control<PanelLease>({
    action: "bindSettingsPage",
    panelId,
    allowMove: settingsAllowsMove(),
  });
}

export async function synchronizeSettingsWindows(
  client: PanelWindowClient,
  snapshot: NativePanelSnapshot,
) {
  for (const view of snapshot.settingsPages ?? []) {
    if (settingsWindowTabId(view.panelId) && view.allowMove !== settingsAllowsMove()) {
      try {
        await bindSettingsWindow(client, view.panelId);
      } catch (error) {
        if (!String((error as Error)?.message ?? error).includes("panel interaction in progress"))
          throw error;
      }
    }
  }
}
