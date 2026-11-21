import type { PanelLease } from "@/lib/panels/windowProtocol";
import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { previewOwners } from "./owner";

export type PreviewCommand =
  | { operation: "ready" | "decodeError" | "close" | "retry" | "dock" | "undock" | "edit" }
  | { operation: "selectProvider"; providerId: string };
export interface PreviewWindowAction {
  kind: "preview";
  id: string;
  attemptId: string;
  revision: string;
  command: PreviewCommand;
}
/** The native queue has already claimed this exact origin. Resolve again at
 * effect time: a valid lease is NOT authority over a replaced preview target. */
export function executePreviewWindowAction(lease: PanelLease, request: PreviewWindowAction) {
  const windows = usePanelWindows.getState();
  const owner = previewOwners.snapshot();
  const snapshot = owner?.context.snapshot;
  if (
    lease.panelId !== "filePreview" ||
    !windows.snapshot.panels.some(
      (p) =>
        p.panelId === lease.panelId &&
        p.windowId === lease.windowId &&
        p.generation === lease.generation,
    ) ||
    !owner ||
    !snapshot ||
    request.id !== snapshot.id ||
    request.attemptId !== snapshot.attemptId ||
    request.revision !== snapshot.revision
  )
    throw new Error("plugin.filePreview.changed");
  owner.context.validate();
  switch (request.command.operation) {
    case "ready":
      owner.onReady?.();
      break;
    case "decodeError":
      owner.source.fail({ code: "validation", message: "preview.mediaError" });
      owner.onDecodeError?.();
      break;
    case "close":
      owner.context.close();
      break;
    case "retry":
      owner.context.retry();
      break;
    case "dock":
      owner.context.dock();
      break;
    case "undock":
      // Quick Look belongs to main. Until its native return transaction is
      // complete, never hide the source or open a phantom main dialog.
      if (lease.windowId !== "main") throw new Error("panel.window.unsupportedPresentation");
      owner.context.undock();
      break;
    case "selectProvider":
      owner.context.selectProvider(request.command.providerId);
      break;
    case "edit": {
      if (snapshot.renderer !== "text" && snapshot.renderer !== "markdown")
        throw new Error("plugin.filePreview.unavailable");
      if (snapshot.source.kind === "local") useWorkspace.getState().openLocalEditor(snapshot.path);
      else {
        const sessionId = snapshot.source.sessionId;
        const session = useSsh.getState().sessions.find((session) => session.id === sessionId);
        if (!session) throw new Error("plugin.filePreview.changed");
        useWorkspace.getState().openEditor(session, snapshot.path);
      }
      owner.context.close();
      break;
    }
  }
  return null;
}
