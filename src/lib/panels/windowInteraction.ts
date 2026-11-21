import type { PanelWindowClient } from "./windowClient";
import type { PanelLease } from "./windowProtocol";

/** Original document-local consent, never a transferable capability. Retiring a
 * pending acquisition also retires its eventual exact token. Native resource
 * workers retain their own actual-effect fence independently of this UI. */
export function createPanelWindowInteraction(client: PanelWindowClient, requested: PanelLease) {
  const lease: PanelLease = Object.freeze({
    panelId: requested.panelId,
    windowId: requested.windowId,
    generation: requested.generation,
  });
  let open = true;
  let release: Promise<void> | undefined;
  const acquired = client.control<string>({ action: "beginInteraction", lease });
  const check = () => {
    if (!open) throw new Error("panel.window.disposed");
  };
  const close = () => {
    open = false;
    release ??= acquired
      .then(
        (id) => client.control<void>({ action: "endInteraction", lease, id }),
        () => {},
      )
      .catch((error: unknown) => {
        release = undefined;
        throw error;
      });
    return release;
  };
  return Object.freeze({ lease, acquired, check, close });
}
