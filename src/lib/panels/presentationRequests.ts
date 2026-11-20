import { useWindowViews } from "./windowViews";
import {
  sourcePanelPresentation,
  subscribeSourcePanelPresentation,
  type SourcePanelMetadata,
} from "./sourcePresentation";
import type { PanelWindowClient } from "./windowClient";
import type {
  PanelPresentationJob,
  PanelLayoutMetadata,
  PanelTransferOffer,
} from "./windowProtocol";

/** Explicit projection: never relay adapter internals or future content fields. */
export function panelLayoutMetadata(row: SourcePanelMetadata): PanelLayoutMetadata {
  return {
    presentation: row.presentation,
    visible: row.visible,
    pinned: row.pinned,
    bounds: row.bounds
      ? { x: row.bounds.x, y: row.bounds.y, width: row.bounds.width, height: row.bounds.height }
      : null,
    available: row.available,
    presentations: [...row.presentations],
  };
}
export async function publishStagedPresentation(
  client: PanelWindowClient,
  offer: PanelTransferOffer,
) {
  const row = sourcePanelPresentation()?.readStaged(offer.lease.panelId);
  if (!row?.available || row.windowId !== client.windowId)
    throw new Error("panel.window.viewNotReady");
  await client.control({
    action: "publishStagedPresentation",
    id: offer.id,
    metadata: panelLayoutMetadata(row),
  });
}
/** Native owns admission and the exact source lease. This executor never owns
 * plugin activation, business resources or another window's presentation. */
export function startPresentationRequests(
  client: PanelWindowClient,
  failure: (error: unknown) => void,
) {
  let disposed = false,
    queued = false,
    running = false;
  let hostStop: (() => void) | undefined, nativeStop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = new Set<string>(),
    activePanels = new Map<string, number>(),
    published = new Map<string, string>();
  const report = (error: unknown) => {
    if (!disposed) {
      try {
        failure(error);
      } catch {
        /* diagnostics must not suppress native cleanup */
      }
    }
  };
  const execute = async (job: PanelPresentationJob) => {
    active.add(job.id);
    activePanels.set(job.lease.panelId, (activePanels.get(job.lease.panelId) ?? 0) + 1);
    let completed = false;
    try {
      const host = sourcePanelPresentation();
      if (disposed || !host || job.lease.windowId !== client.windowId) return;
      await client.control({ action: "beginPresentation", id: job.id });
      // Begin is native admission, not permission to mutate a replacement React
      // adapter after this IPC returns. No intervening await before the UI change.
      if (disposed || sourcePanelPresentation() !== host) return;
      if (job.operation.kind === "set") host.set(job.lease.panelId, job.operation.presentation);
      else host.close(job.lease.panelId);
      const row = host.read().find((row) => row.id === job.lease.panelId);
      if (!row || row.windowId !== client.windowId) throw new Error("panel.window.viewNotReady");
      await client.completePresentation(job.id, panelLayoutMetadata(row));
      completed = true;
    } catch (error) {
      report(error);
    } finally {
      if (!completed) await client.failPresentation(job.id).catch(() => {});
      active.delete(job.id);
      const remaining = (activePanels.get(job.lease.panelId) ?? 1) - 1;
      if (remaining) activePanels.set(job.lease.panelId, remaining);
      else activePanels.delete(job.lease.panelId);
      schedule();
    }
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
          const host = sourcePanelPresentation();
          if (!host) continue;
          const snapshot = await client.snapshot();
          if (disposed || sourcePanelPresentation() !== host) continue;
          const rows = host.read();
          const currentKeys = new Set<string>();
          for (const lease of snapshot.panels.filter((p) => p.windowId === client.windowId)) {
            const row = rows.find((row) => row.id === lease.panelId);
            if (!row) continue;
            if (row.windowId !== client.windowId) throw new Error("panel.window.staleOwner");
            const key = `${lease.panelId}:${lease.generation}`;
            currentKeys.add(key);
            // Claims start only after this serialized publisher's prior sends
            // settle. Keep this panel's publication lane reserved until source
            // completion, so an older refresh cannot overwrite the API result.
            // Other panels continue publishing while Begin replies are delayed.
            if (activePanels.has(lease.panelId)) continue;
            const metadata = panelLayoutMetadata(row),
              encoded = JSON.stringify(metadata);
            if (published.get(key) === encoded) continue;
            try {
              await client.control({ action: "publishPresentation", lease, metadata });
              published.set(key, encoded);
            } catch (error) {
              if (!disposed) {
                const current = await client.snapshot();
                if (
                  current.panels.some(
                    (p) =>
                      p.panelId === lease.panelId &&
                      p.windowId === lease.windowId &&
                      p.generation === lease.generation,
                  )
                )
                  throw error;
                queued = true;
              }
            }
            if (disposed || sourcePanelPresentation() !== host) break;
          }
          for (const key of published.keys())
            if (key !== "unavailable-preview" && !currentKeys.has(key)) published.delete(key);
          if (disposed || sourcePanelPresentation() !== host) continue;
          if (client.windowId === "main") {
            const preview = host.readStaged("filePreview");
            if (preview && !preview.available) {
              const metadata = panelLayoutMetadata(preview),
                encoded = JSON.stringify(metadata);
              if (published.get("unavailable-preview") !== encoded) {
                await client.control({ action: "publishUnavailablePreview", metadata });
                published.set("unavailable-preview", encoded);
              }
            }
          }
          const jobs = await client.claimPresentations();
          for (const job of jobs) void execute(job);
        }
      } catch (error) {
        report(error);
      } finally {
        running = false;
      }
    })();
  };
  const schedule = () => {
    if (!disposed && timer === undefined)
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 40);
  };
  const rebind = () => {
    hostStop?.();
    hostStop = sourcePanelPresentation()?.subscribe(schedule);
    published.clear();
    schedule();
  };
  const registryStop = subscribeSourcePanelPresentation(rebind);
  const viewsStop = useWindowViews.subscribe(schedule);
  rebind();
  void client.subscribe(schedule).then((stop) => {
    if (disposed) stop();
    else {
      nativeStop = stop;
      schedule();
    }
  }, report);
  return () => {
    disposed = true;
    queued = false;
    clearTimeout(timer);
    hostStop?.();
    nativeStop?.();
    registryStop();
    viewsStop();
    for (const id of active) void client.failPresentation(id).catch(() => {});
  };
}
