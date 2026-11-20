import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { usePanelWindows } from "@/store/panelWindows";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import { previewOwners, type createPreviewOwners } from "./owner";
import { previewWindowData, type PreviewWindowData } from "./windowModel";

// Serial across coordinator restarts, including late IPC and teardown.
let writerTail: Promise<unknown> = Promise.resolve();
let activeWriter: object | undefined;

export interface PreviewWindowModel extends WindowModelAppearance {
  readonly preview: PreviewWindowData | null;
}
/** One ordered writer publishes the private resource BEFORE its read model.
 * Appearance/progress refreshes never rotate a native resource's epoch. */
export function startPreviewWindowPublication(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (error: unknown) => void,
  owners: ReturnType<typeof createPreviewOwners> = previewOwners,
) {
  const identity = {};
  activeWriter = identity;
  let disposed = false,
    running = false,
    queued = false;
  const send = <T = unknown>(
    request: Parameters<PanelWindowClient["control"]>[0],
    cleanup = false,
  ) => {
    const result = writerTail.then(() => {
      if (activeWriter !== identity || (disposed && !cleanup))
        throw new Error("panel.window.disposed");
      return client.control<T>(request);
    });
    writerTail = result.catch(() => {});
    return result;
  };
  let publisher: string | undefined,
    revision = 0;
  let publishedResource: string | undefined;
  let touchedResource = false;
  let source = owners.snapshot()?.source;
  let stopSource: (() => void) | undefined;
  const registration = () => {
    const lease = usePanelWindows
      .getState()
      .snapshot.panels.find((p) => p.panelId === "filePreview");
    return lease ? `${lease.windowId}:${lease.generation}` : null;
  };
  const present = () => registration() !== null;
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          const owner = owners.snapshot();
          const registered = registration();
          const available = registered !== null;
          const read = available && owner ? owner.source.snapshot() : null;
          const resource =
            owner && read?.status === "ready" && read.value.info
              ? { id: owner.context.snapshot.attemptId, ticket: read.value.info.id }
              : null;
          const key = JSON.stringify(resource);
          if (key !== publishedResource) {
            if (resource) touchedResource = true;
            await send({ action: "publishPreviewResource", resource });
            if (!resource) touchedResource = false;
            publishedResource = key;
          }
          if (disposed) break;
          if (!available) {
            publisher = undefined;
            revision = 0;
            continue;
          }
          if (registered !== registration()) {
            publisher = undefined;
            revision = 0;
            queued = true;
            continue;
          }
          publisher ??= await send<string>({ action: "beginModel", panelId: "filePreview" });
          // The owner can change during either IPC. Never publish an old target
          // after a replacement, nor a ticket from a mismatched source/model.
          if (disposed) break;
          if (registered !== registration()) {
            publisher = undefined;
            revision = 0;
            queued = true;
            continue;
          }
          if (
            owner !== owners.snapshot() ||
            !present() ||
            (owner && read !== owner.source.snapshot())
          ) {
            queued = true;
            continue;
          }
          const model: PreviewWindowModel = {
            ...appearance(),
            preview: owner ? previewWindowData(owner) : null,
          };
          await send({
            action: "publishModel",
            panelId: "filePreview",
            publisher,
            revision: ++revision,
            model,
          });
        }
      } catch (error) {
        // A close/reopen can remove the panel while begin/publish is in flight.
        // Reacquire a publisher on the next invalidation, never reuse its token.
        publisher = undefined;
        if (!disposed && present()) failure(error);
      } finally {
        running = false;
        if (queued && !disposed) refresh();
      }
    })();
  };
  const follow = () => {
    const next = owners.snapshot()?.source;
    if (next !== source || !stopSource) {
      stopSource?.();
      source = next;
      stopSource = source?.subscribe(refresh);
    }
    refresh();
  };
  const stopOwners = owners.subscribe(follow);
  let panelRegistration = registration();
  const stopPanels = usePanelWindows.subscribe(() => {
    const next = registration();
    if (next === panelRegistration) return;
    panelRegistration = next;
    publisher = undefined;
    revision = 0;
    refresh();
  });
  follow();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopOwners();
      stopPanels();
      stopSource?.();
      // Preserve ordering with any in-flight publication; a stopped writer must
      // never publish its old resource after cleanup of this coordinator.
      if (touchedResource)
        void send({ action: "publishPreviewResource", resource: null }, true).catch(() => {});
    },
  };
}
