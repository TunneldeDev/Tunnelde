import type { PanelWindowClient } from "./windowClient";
import type { NativePanelSnapshot } from "./windowProtocol";
import type { WindowViews } from "./windowViews";

/** A satellite owns view trees, never a resource/bootstrap coordinator. */
export function startSatelliteViews(
  client: PanelWindowClient,
  views: WindowViews,
  {
    receive,
    failure,
  }: { receive: (snapshot: NativePanelSnapshot) => void; failure: (error: unknown) => void },
) {
  let disposed = false,
    queued = false,
    running = false,
    closing = false,
    preparingClose = false,
    hadPanel = false;
  const staging = new Map<string, AbortController>();
  const cleanups: (() => void)[] = [];
  const reconcile = async () => {
    const checkCloseRollback = closing && !preparingClose;
    const snapshot = await client.snapshot();
    if (disposed) return;
    receive(snapshot);
    hadPanel ||= snapshot.panels.some((panel) => panel.windowId === client.windowId);
    await views.reconcile(snapshot);
    if (disposed) return;
    for (const [id, controller] of staging) {
      if (snapshot.transfers.some(({ offer }) => offer.id === id)) continue;
      controller.abort();
      staging.delete(id);
    }
    for (const { offer } of snapshot.transfers) {
      if (offer.targetWindow !== client.windowId || staging.has(offer.id)) continue;
      const controller = new AbortController();
      staging.set(offer.id, controller);
      void (async () => {
        try {
          const staged = await client.control<{ state: unknown }>({
            action: "staged",
            id: offer.id,
          });
          if (disposed || controller.signal.aborted) return;
          await views.stage(offer, staged.state, controller.signal);
          if (!disposed && !controller.signal.aborted)
            await client.control({ action: "acknowledge", id: offer.id });
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            await client.control({ action: "cancel", id: offer.id }).catch(() => {});
            failure(error);
          }
        }
      })();
    }
    if (
      closing &&
      checkCloseRollback &&
      !preparingClose &&
      snapshot.panels.some((panel) => panel.windowId === client.windowId) &&
      !snapshot.transfers.some(({ offer }) => offer.lease.windowId === client.windowId)
    ) {
      // A deadline/cancellation must restore an interactive owner, not strand a
      // native window in permanent closing state after its return offer expired.
      closing = false;
      await client.control({ action: "cancelClose" });
      failure(new Error("panel.window.closeCancelled"));
      return;
    }
    if (
      !preparingClose &&
      (closing || hadPanel) &&
      !snapshot.panels.some((panel) => panel.windowId === client.windowId) &&
      !snapshot.transfers.some(
        ({ offer }) =>
          offer.targetWindow === client.windowId || offer.lease.windowId === client.windowId,
      )
    )
      await client.destroy(client.windowId);
  };
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          await reconcile();
        }
      } catch (error) {
        if (!disposed) failure(error);
      } finally {
        running = false;
      }
    })();
  };
  const close = async () => {
    if (closing || disposed) return;
    closing = true;
    preparingClose = true;
    try {
      const snapshot = await client.snapshot();
      // Capture before beginClose freezes the document. Native rejects closing
      // while a resource action/credential interaction is still in progress.
      const panels = snapshot.panels.filter((panel) => panel.windowId === client.windowId);
      const states = panels.map((panel) => ({ panel, state: views.capture(panel.panelId) }));
      await client.control({ action: "beginClose" });
      for (const { panel, state } of states)
        await client.control({ action: "prepare", lease: panel, targetWindow: "main", state });
      preparingClose = false;
      refresh();
    } catch (error) {
      preparingClose = false;
      closing = false;
      await client.control({ action: "cancelClose" }).catch(() => {});
      if (!disposed) failure(error);
    }
  };
  const ready = (async () => {
    const subscribe = await client.subscribe(refresh);
    if (disposed) {
      subscribe();
      return;
    }
    cleanups.push(subscribe);
    const onClose = await client.onClose(() => {
      void close();
    });
    if (disposed) {
      onClose();
      return;
    }
    cleanups.push(onClose);
    await client.control({ action: "ready" });
    if (!disposed) refresh();
  })().catch((error) => {
    if (!disposed) failure(error);
  });
  return {
    ready,
    refresh,
    close,
    dispose() {
      disposed = true;
      queued = false;
      for (const cleanup of cleanups) cleanup();
      for (const controller of staging.values()) controller.abort();
      staging.clear();
    },
  };
}
