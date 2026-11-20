import type { PanelWindowClient } from "./windowClient";
import type { PanelLease } from "./windowProtocol";
import type { WindowViewRecord } from "./windowViews";
import type { WindowProviderOwner } from "./windowProviderSource";

/** Display identity survives staged promotion. Mutation authority is installed
 * only by a committed React effect and cannot be revived by a replaced view. */
export function createWindowProviderOwner(
  client: PanelWindowClient,
  record: WindowViewRecord,
  options: { current(): WindowViewRecord | undefined; frozen(): boolean },
) {
  let committed: PanelLease | undefined;
  const current = () => {
    const next = options.current();
    if (
      !next ||
      next.key !== record.key ||
      next.controller !== record.controller ||
      next.panelId !== record.panelId ||
      next.failed
    )
      throw new Error("panel.window.staleOwner");
    return next;
  };
  const owner: WindowProviderOwner = Object.freeze({
    client,
    check(mutation: boolean) {
      const next = current();
      if (
        mutation &&
        (!committed ||
          next.staged ||
          next.moving ||
          options.frozen() ||
          next.lease?.panelId !== committed.panelId ||
          next.lease.windowId !== committed.windowId ||
          next.lease.generation !== committed.generation)
      )
        throw new Error("panel.window.staleOwner");
    },
    target() {
      const next = current();
      if (next.staged) return { kind: "staged" as const, id: next.key };
      if (!next.lease || next.lease.windowId !== client.windowId)
        throw new Error("panel.window.staleOwner");
      return { kind: "owned" as const, lease: { ...next.lease } };
    },
  });
  return {
    owner,
    start(lease?: PanelLease) {
      const scope = lease && Object.freeze({ ...lease });
      const next = current();
      if (
        scope &&
        (next.staged ||
          next.lease?.generation !== scope.generation ||
          next.lease.windowId !== scope.windowId ||
          scope.panelId !== record.panelId)
      )
        throw new Error("panel.window.staleOwner");
      committed = scope;
      return () => {
        if (committed === scope) committed = undefined;
      };
    },
  };
}
