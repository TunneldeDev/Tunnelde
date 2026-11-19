import type { LocalPanelWorkspace } from "./localWorkspace";
export const LOCAL_PANEL_MIME = "application/x-tunnelde-local-panel";
let drag: { token: string; panelId: string; workspace: LocalPanelWorkspace } | null = null;
export function startLocalPanelDrag(
  workspace: LocalPanelWorkspace,
  panelId: string,
  transfer: DataTransfer,
) {
  drag = { token: crypto.randomUUID(), panelId, workspace };
  transfer.setData(LOCAL_PANEL_MIME, drag.token);
  transfer.effectAllowed = "move";
}
export function readLocalPanelDrag(
  workspace: LocalPanelWorkspace,
  transfer: Pick<DataTransfer, "getData"> | null,
) {
  if (
    !drag ||
    !transfer ||
    drag.workspace !== workspace ||
    transfer.getData(LOCAL_PANEL_MIME) !== drag.token
  )
    return null;
  const state = workspace.store.getState();
  return state.floating.includes(drag.panelId) ||
    state.groups.some((group) => group.panels.includes(drag!.panelId))
    ? drag.panelId
    : null;
}
export function endLocalPanelDrag() {
  drag = null;
}

/** For the private native-drag bridge only; still requires a host-issued lease. */
export function localPanelDragId(transfer: Pick<DataTransfer, "getData">) {
  return drag && readLocalPanelDrag(drag.workspace, transfer);
}
