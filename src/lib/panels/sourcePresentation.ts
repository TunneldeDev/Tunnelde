import type { PanelWindowClient } from "./windowClient";
import { useWindowViews } from "./windowViews";
import type { PanelPresentation } from "@/store/panelPresentation";
import type { FloatingRect } from "@/lib/layout/floatingPanel";

/** Closed layout metadata, never content, view capsules, native credentials or
 * feature stores. All functions act in the document which installed this host. */
export interface SourcePanelMetadata {
  id: string;
  windowId: string;
  presentation: PanelPresentation;
  visible: boolean;
  pinned: boolean;
  bounds: FloatingRect | null;
  available: boolean;
  presentations: readonly PanelPresentation[];
}
export interface SourcePanelPresentation {
  read: () => SourcePanelMetadata[];
  /** Read the target slot during inert staging; never grants mutation authority. */
  readStaged: (id: string) => SourcePanelMetadata | undefined;
  set: (id: string, presentation: PanelPresentation) => SourcePanelMetadata;
  close: (id: string) => void;
  reveal: (id: string) => void;
  subscribe: (changed: () => void) => () => void;
}
let current: SourcePanelPresentation | null = null;
const observers = new Set<() => void>();
const notify = () => {
  for (const observer of observers) {
    try {
      observer();
    } catch {
      // A failed observer cannot strand installation/disposal or prevent other
      // document-scoped executors from seeing the replacement adapter.
    }
  }
};
export function subscribeSourcePanelPresentation(changed: () => void) {
  observers.add(changed);
  return () => {
    observers.delete(changed);
  };
}
export const sourcePanelPresentation = () => current;
/** One view adapter, not another application/resource coordinator. */
export function installSourcePanelPresentation(host: SourcePanelPresentation) {
  if (current) throw new Error("panel.window.alreadyInstalled");
  current = host;
  notify();
  return () => {
    if (current === host) {
      current = null;
      notify();
    }
  };
}

/** Exact-generation focus routing is a presentation effect only. The native
 * host already admitted the user's focus request; no resources are restarted. */
export function startSourcePanelFocus(
  client: PanelWindowClient,
  failure: (error: unknown) => void,
) {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void client
    .onPanelFocus((lease) => {
      const record = useWindowViews.getState().entries.get(lease.panelId);
      if (
        disposed ||
        lease.windowId !== client.windowId ||
        record?.staged ||
        record?.lease?.windowId !== client.windowId ||
        record.lease.generation !== lease.generation
      )
        return;
      try {
        current?.reveal(lease.panelId);
      } catch (error) {
        failure(error);
      }
    })
    .then(
      (stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      },
      (error) => {
        if (!disposed) failure(error);
      },
    );
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
