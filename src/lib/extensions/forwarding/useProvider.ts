import { useMemo } from "react";
import { usePlugins } from "@/store/plugins";
import type { FrontendForwarding } from "../contracts/forwarding/provider";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { createProviderLease } from "../runtime/providers/lease";
import type { ForwardingContext } from "./context";
import { createForwardingAuthority } from "./authority";
import { guardForwardingProvider } from "./provider";

/** Keep domain continuations separate from the shared selection/recovery shell. */
export function useForwardingProvider(
  context: (ForwardingContext & Pick<FrontendForwarding, "Entries">) | undefined,
  token: string | undefined,
  view: string | undefined,
  owner: string | undefined,
  canWrite: boolean,
  checkAccess: CheckProviderAccess,
  lease: ReturnType<typeof createProviderLease>,
) {
  const authority = useMemo(
    () =>
      context && token && view && owner
        ? createForwardingAuthority(
            token,
            view,
            context.snapshot.hostId,
            () => {
              checkAccess();
              if (
                !usePlugins
                  .getState()
                  .items.find((item) => item.id === owner)
                  ?.permissions.includes("forwards.write")
              )
                throw new Error("plugin.forwarding.permissionDenied");
            },
            lease.retain,
          )
        : undefined,
    // Authority survives list revisions, but always reads current permission and identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lease, context?.snapshot.hostId, token, view, owner],
  );
  return context && authority
    ? guardForwardingProvider(context, checkAccess, authority, canWrite)
    : undefined;
}
