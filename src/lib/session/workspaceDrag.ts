import { clearFilePaneDrag, FILE_PANE_MIME, filePaneDrag } from "./filePaneDrag";
import { sidebarViewOf, TAB_MIME } from "./sidebarDock";
import { useWorkspace } from "@/store/workspace";

export function isWorkspaceDrag(transfer: Pick<DataTransfer, "types"> | null): boolean {
  return !!transfer?.types.some((type) => type === TAB_MIME || type === FILE_PANE_MIME);
}

/** Resolve only at drop: hovering must never open or detach a file panel. */
export function readWorkspaceDrop(transfer: Pick<DataTransfer, "getData"> | null) {
  if (!transfer) return null;
  const file = filePaneDrag(transfer.getData(FILE_PANE_MIME));
  const workspace = useWorkspace.getState();
  const existing = transfer.getData(TAB_MIME);
  if (!file && !workspace.tabs.some((tab) => tab.id === existing) && !sidebarViewOf(existing))
    return null;
  return {
    tabId: file ? workspace.openFilePane(file.pane, file.title) : existing,
    size: file?.size,
    finish: () => {
      if (!file) return;
      clearFilePaneDrag();
      file.onMoved?.();
    },
  };
}
