import { mainPanelWindowClient } from "@/app/panelWindows";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { useWorkspace } from "@/store/workspace";
import { settingsWindowTabId } from "./registration";
import { executeSettingsCommand } from "./mainBinding";
import type { SettingsWindowCommand } from "./protocol";
/** Native already fences window/document/generation; retain canonical tab
 * incarnation in main before any effect. Panel names are not authority. */
export async function executeSettingsWindowAction(
  lease: PanelLease,
  command: SettingsWindowCommand,
) {
  const tab = useWorkspace
    .getState()
    .tabs.find((tab) => tab.id === settingsWindowTabId(lease.panelId));
  if (!tab || !["settings", "updates"].includes(tab.kind))
    throw new Error("panel.window.staleOwner");
  const controller = new AbortController();
  const stop = useWorkspace.subscribe((state) => {
    if (!state.tabs.some((current) => current.id === tab.id && current.kind === tab.kind))
      controller.abort();
  });
  try {
    return await executeSettingsCommand(
      command,
      async () => {
        const client = mainPanelWindowClient();
        if (!client || client.windowId !== "main") throw new Error("panel.window.staleOwner");
        return client.control<string>({ action: "readSettingsPasswordForOwner", lease });
      },
      controller.signal,
    );
  } finally {
    stop();
  }
}
