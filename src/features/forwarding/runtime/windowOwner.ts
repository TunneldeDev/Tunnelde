import { usePanelWindows } from "@/store/panelWindows";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
import { createWindowForwardingActions } from "./windowActions";
import type { WindowForwardingViewOwner } from "./windowProviderSource";

/** One display owner survives staging/promotion. Every action owner is a new,
 * effect-committed exact lease; abandoned React renders acquire nothing. */
export function createWindowForwardingOwner(
  client: PanelWindowClient,
  record: Pick<WindowViewRecord, "key" | "panelId" | "controller">,
  options: {
    current(): WindowViewRecord | undefined;
    frozen(): boolean;
    refresh(): void;
    report(error: unknown): void;
  },
) {
  const { key, panelId, controller } = record;
  if (
    panelId !== "forwarding" &&
    !usePanelWindows.getState().snapshot.hostPages?.some((v) => v.panelId === panelId)
  )
    throw new Error("panel.window.unsupportedView");
  const listeners = new Set<() => void>();
  type Active = { lease: PanelLease; service: ReturnType<typeof createWindowForwardingActions> };
  let active: Active | null = null;
  const current = () => {
    const next = options.current();
    if (
      !next ||
      next.key !== key ||
      next.panelId !== panelId ||
      next.controller !== controller ||
      next.failed
    )
      throw new Error("panel.window.staleOwner");
    return next;
  };
  const same = (a: PanelLease | undefined, b: PanelLease) =>
    a?.panelId === b.panelId && a.windowId === b.windowId && a.generation === b.generation;
  const check = (mutation: boolean) => {
    const next = current();
    if (
      mutation &&
      (!active || next.staged || next.moving || options.frozen() || !same(next.lease, active.lease))
    )
      throw new Error("panel.window.staleOwner");
  };
  const owner: WindowForwardingViewOwner = Object.freeze({
    client,
    check,
    target() {
      const next = current();
      if (next.staged) return { kind: "staged" as const, id: key };
      if (!next.lease || next.lease.windowId !== client.windowId || next.lease.panelId !== panelId)
        throw new Error("panel.window.staleOwner");
      return { kind: "owned" as const, lease: { ...next.lease } };
    },
  });
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    owner,
    snapshot: () => active,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(requested?: PanelLease) {
      active?.service.dispose();
      active = null;
      let scope: Active | null = null;
      if (requested) {
        const lease = Object.freeze({ ...requested });
        const next = current();
        if (
          next.staged ||
          !same(next.lease, lease) ||
          lease.panelId !== panelId ||
          lease.windowId !== client.windowId
        )
          throw new Error("panel.window.staleOwner");
        const service = createWindowForwardingActions(client, lease, {
          check() {
            check(true);
            if (active !== scope) throw new Error("panel.window.staleOwner");
          },
          refresh: options.refresh,
          report: options.report,
        });
        scope = { lease, service };
        active = scope;
      }
      publish();
      return () => {
        scope?.service.dispose();
        if (active === scope) {
          active = null;
          publish();
        }
      };
    },
  };
}
