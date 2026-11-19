import type { PanelWindowClient } from "./windowClient";
import { transferablePanel } from "./windowViews";
import { movePanelToWindow } from "./windowMoves";
import { localPanelDragId } from "./localPanelDrag";
import { SIDEBAR_MIME } from "@/lib/session/sidebarDock";
import { usePanelWindows } from "@/store/panelWindows";
import {
  INTERNAL_DRAG_FINISH,
  NATIVE_PANEL_DRAG_READY,
  type InternalDragFinish,
} from "@/lib/session/internalDragEvents";

interface Gesture {
  token?: string;
  ended: boolean;
}
/** Optional native endpoint for the common pointer drag driver. Local drops
 * remain synchronous; cross-WebView moves use the existing staged handoff.
 * No browser-supplied destination, screen coordinates, or transferable authority.
 */
export function installPanelWindowDrag(
  client: PanelWindowClient,
  failure: (error: unknown) => void,
  move: typeof movePanelToWindow = movePanelToWindow,
) {
  let disposed = false;
  let gesture: Gesture | undefined;
  const cancel = (current: Gesture) => {
    current.ended = true;
    if (current.token)
      void client.control({ action: "cancelDrag", token: current.token }).catch(() => {});
  };
  const start = (event: DragEvent) => {
    if (!event.dataTransfer || disposed) return;
    if (gesture) cancel(gesture);
    gesture = undefined;
    const panelId =
      localPanelDragId(event.dataTransfer) || event.dataTransfer.getData(SIDEBAR_MIME);
    if (!panelId || !transferablePanel(panelId)) return;
    const lease = usePanelWindows
      .getState()
      .snapshot.panels.find(
        (panel) => panel.panelId === panelId && panel.windowId === client.windowId,
      );
    if (!lease) return;
    const transfer = event.dataTransfer;
    const current: Gesture = { ended: false };
    gesture = current;
    void client
      .control<string>({ action: "issueDrag", lease })
      .then((token) => {
        current.token = token;
        // Even a reply arriving after release/disposal must retire its grant.
        if (disposed || current.ended) cancel(current);
        else transfer.setData(NATIVE_PANEL_DRAG_READY, "true");
      })
      .catch(() => {
        // A local drag is still valid while native movement is blocked. Do not
        // interrupt it with a toast; no native grant means no cross-window move.
      });
  };
  const finish = (event: Event) => {
    const current = gesture;
    gesture = undefined;
    if (!current) return;
    const { released, accepted } = (event as CustomEvent<InternalDragFinish>).detail;
    if (!released || accepted || !current.token || disposed) {
      cancel(current);
      return;
    }
    current.ended = true;
    // Start native hit testing immediately on release, not after awaiting a
    // grant/snapshot. An exceptionally fast gesture without a grant is cancelled.
    void client
      .releaseDrag(current.token)
      .then(async ({ lease, targetWindow }) => {
        if (disposed || targetWindow === client.windowId) return;
        await move(lease.panelId, targetWindow ?? undefined, lease);
      })
      .catch((error) => {
        cancel(current);
        if (!disposed) failure(error);
      });
  };
  document.addEventListener("dragstart", start);
  document.addEventListener(INTERNAL_DRAG_FINISH, finish);
  return () => {
    disposed = true;
    if (gesture) cancel(gesture);
    gesture = undefined;
    document.removeEventListener("dragstart", start);
    document.removeEventListener(INTERNAL_DRAG_FINISH, finish);
  };
}
