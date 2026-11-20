import { publishStagedPresentation } from "./presentationRequests";
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
    nativeClosing = false,
    hadPanel = false;
  const lifetime = new AbortController();
  let closePanels: NativePanelSnapshot["panels"] = [];
  const unfreezeClose = () => {
    for (const panel of closePanels) views.setMoving(panel.panelId, false, panel);
    closePanels = [];
  };
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
          if (!disposed && !controller.signal.aborted) {
            await publishStagedPresentation(client, offer);
            if (!disposed && !controller.signal.aborted)
              await client.control({ action: "acknowledge", id: offer.id });
          }
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
      await client.control({ action: "cancelClose" });
      nativeClosing = false;
      unfreezeClose();
      closing = false;
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
    let panels: NativePanelSnapshot["panels"] = [];
    try {
      const snapshot = await client.snapshot();
      if (disposed) return;
      // Capture before beginClose freezes the document. Native rejects closing
      // while a resource action/credential interaction is still in progress.
      panels = snapshot.panels.filter((panel) => panel.windowId === client.windowId);
      closePanels = panels;
      for (const panel of panels) views.setMoving(panel.panelId, true, panel);
      const states = [];
      // One document-local consent at a time. No panel is submitted unless
      // every capture/reset decision succeeds and beginClose freezes the set.
      for (const panel of panels)
        states.push({
          panel,
          state: await views.captureForMove(panel.panelId, lifetime.signal),
        });
      if (disposed) return;
      nativeClosing = true;
      const frozen = await client.control<NativePanelSnapshot["panels"]>({ action: "beginClose" });
      // beginClose atomically returns the frozen membership. A panel may have
      // entered/left during an asynchronous capture; never close a partial set.
      if (
        frozen.length !== panels.length ||
        frozen.some(
          (lease) =>
            !panels.some(
              (panel) =>
                panel.panelId === lease.panelId &&
                panel.windowId === lease.windowId &&
                panel.generation === lease.generation,
            ),
        )
      )
        throw new Error("panel.window.staleOwner");
      for (const { panel, state } of states) {
        if (disposed) throw new Error("panel.window.cancelled");
        await client.control({ action: "prepare", lease: panel, targetWindow: "main", state });
      }
      preparingClose = false;
      refresh();
    } catch (error) {
      if (nativeClosing) await client.control({ action: "cancelClose" }).catch(() => {});
      nativeClosing = false;
      unfreezeClose();
      preparingClose = false;
      closing = false;
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
      lifetime.abort();
      if (nativeClosing) void client.control({ action: "cancelClose" }).catch(() => {});
      unfreezeClose();
      queued = false;
      for (const cleanup of cleanups) cleanup();
      for (const controller of staging.values()) controller.abort();
      staging.clear();
    },
  };
}
