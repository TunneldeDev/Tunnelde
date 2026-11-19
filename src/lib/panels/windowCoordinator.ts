import type { PanelWindowClient } from "./windowClient";
import type { NativePanelSnapshot, PanelTransferOffer } from "./windowProtocol";

/** Main-document coordination only. This adapter owns neither SSH sessions nor
 * feature stores, and never creates a second persistence/autoconnect worker. */
export function startPanelWindowCoordinator(
  client: PanelWindowClient,
  {
    panelIds,
    receive,
    stage,
    failure,
  }: {
    panelIds: () => readonly string[];
    receive: (snapshot: NativePanelSnapshot) => void;
    stage?: (offer: PanelTransferOffer, state: unknown, signal: AbortSignal) => Promise<void>;
    failure: (error: unknown) => void;
  },
) {
  if (client.windowId !== "main") throw new Error("panel.window.coordinatorRequired");
  let disposed = false,
    queued = false,
    running = false;
  let unsubscribe: (() => void) | undefined;
  const staging = new Map<string, AbortController>();
  const reconcile = async () => {
    let snapshot = await client.snapshot();
    if (disposed) return;
    const ids = new Set(panelIds());
    for (const panel of snapshot.panels) {
      if (ids.has(panel.panelId)) continue;
      await client.control({ action: "removePanel", panelId: panel.panelId });
      if (disposed) return;
    }
    for (const id of ids) {
      if (snapshot.panels.some((panel) => panel.panelId === id)) continue;
      await client.control({ action: "addPanel", panelId: id });
      if (disposed) return;
    }
    snapshot = await client.snapshot();
    if (disposed) return;
    const pendingIds = new Set(snapshot.transfers.map(({ offer }) => offer.id));
    for (const [id, controller] of staging) {
      if (pendingIds.has(id)) continue;
      controller.abort();
      staging.delete(id);
    }
    receive(snapshot);
    for (const { offer, ready } of snapshot.transfers) {
      if (disposed) return;
      if (ready) {
        try {
          await client.control({ action: "commit", id: offer.id });
        } catch (error) {
          // A plugin/user cancellation can retire an acknowledged offer while
          // this IPC is in flight. Native absence is authoritative rollback (or
          // an already committed reply), not a new user-facing move failure.
          const current = await client.snapshot();
          if (current.transfers.some(({ offer: pending }) => pending.id === offer.id)) throw error;
          queued = true;
        }
        continue;
      }
      if (!stage || offer.targetWindow !== client.windowId || staging.has(offer.id)) continue;
      const controller = new AbortController();
      staging.set(offer.id, controller);
      void (async () => {
        try {
          const staged = await client.control<{ state: unknown }>({
            action: "staged",
            id: offer.id,
          });
          if (disposed || controller.signal.aborted) return;
          await stage(offer, staged.state, controller.signal);
          if (disposed || controller.signal.aborted) return;
          // Host rechecks both documents, generation and deadline. Never grant
          // ownership to a view that finished loading after rollback.
          await client.control({ action: "acknowledge", id: offer.id });
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            await client.control({ action: "cancel", id: offer.id }).catch(() => {});
            failure(error);
          }
        } finally {
          if (staging.get(offer.id) === controller) staging.delete(offer.id);
        }
      })();
    }
  };
  let refreshTask = Promise.resolve();
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return refreshTask;
    running = true;
    refreshTask = (async () => {
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
    return refreshTask;
  };
  const ready = (async () => {
    // Subscribe before reading the first snapshot: no gap in invalidations.
    unsubscribe = await client.subscribe(refresh);
    if (disposed) {
      unsubscribe();
      return;
    }
    await client.control({ action: "ready" });
    if (!disposed) await refresh();
  })().catch((error) => {
    if (!disposed) failure(error);
  });
  return {
    ready,
    refresh,
    dispose() {
      disposed = true;
      queued = false;
      unsubscribe?.();
      for (const controller of staging.values()) controller.abort();
      staging.clear();
    },
  };
}
