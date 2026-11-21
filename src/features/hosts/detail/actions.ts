import type { PanelLease } from "@/lib/panels/windowProtocol";
import { useWorkspace } from "@/store/workspace";
import { hostDetailTabId } from "./registration";
import type { HostDetailCommand } from "./protocol";
import { executeHostPanelCommand } from "../panel/execute";
export async function executeHostDetailAction(
  lease: PanelLease,
  command: HostDetailCommand,
  show: () => Promise<unknown>,
) {
  const tab = useWorkspace
    .getState()
    .tabs.find((t) => t.kind === "host" && t.id === hostDetailTabId(lease.panelId));
  if (
    !tab?.hostId ||
    command.host.id !== tab.hostId ||
    !["connect", "sftp", "favorite", "edit", "delete", "duplicate"].includes(command.operation)
  )
    throw new Error("panel.window.staleOwner");
  return executeHostPanelCommand(command, show);
}
