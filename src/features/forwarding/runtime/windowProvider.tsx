import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { FrontendForwarding } from "@/lib/extensions/contracts/forwarding/provider";
import type { FrontendViewProps } from "@/lib/extensions/contracts/frontend/views";
import type { ForwardingContext } from "@/lib/extensions/forwarding/context";
import { guardForwardingProvider } from "@/lib/extensions/forwarding/provider";
import { createProviderLease } from "@/lib/extensions/runtime/providers/lease";
import { openScopedFrontendView } from "@/lib/extensions/runtime/views/frontend";
import { ResourceScopeClosed, type ResourceScope } from "@/lib/extensions/resourceScope";
import type { NativeForwardingProviderDescriptor } from "@/lib/panels/windowProtocol";
import type {
  createNativePluginViewClient,
  NativePluginViewTarget,
} from "@/lib/panels/windowPluginClient";
import type { createWindowForwardingActions } from "./windowActions";

type Owner = {
  /** Absent in a staged display. Promotion supplies a fresh exact-lease service. */
  service?: ReturnType<typeof createWindowForwardingActions>;
  check(mutation: boolean): void;
};
type Scope = { owner: Owner; context: ForwardingContext & Pick<FrontendForwarding, "Entries"> };
const Context = createContext<Scope | null>(null);
export function WindowForwardingProviderScope({
  value,
  children,
}: {
  value: Scope;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Attach only the natively selected module. No main runtime activation,
 * settings/security store, ordinary-view adapter or bearer provider origin.
 * The native child survives staged promotion; its action owner does not.
 */
export async function openWindowForwardingProviderView({
  client,
  target,
  descriptor,
  hostId,
  parent,
  check,
  state,
  signal,
}: {
  client: ReturnType<typeof createNativePluginViewClient>;
  target: NativePluginViewTarget;
  descriptor: NativeForwardingProviderDescriptor;
  hostId: string;
  parent: ResourceScope;
  check(): void;
  state?: { value: unknown };
  signal?: AbortSignal;
}) {
  const selected = structuredClone(descriptor);
  const originalTarget = structuredClone(target);
  let token: string | undefined;
  const mounted = await openScopedFrontendView({
    owner: selected.view,
    viewId: selected.view.viewId,
    parent,
    transport: client.transport,
    openView: async () => {
      const session = await client.openForwardingProvider(originalTarget, hostId, selected);
      token = session.token;
      return session;
    },
    check,
    state,
    signal,
  });
  const live = () => {
    if (mounted.resources.signal.aborted) throw new ResourceScopeClosed();
    check();
  };
  // The original attachment token is retained privately, never passed through
  // props/capsules or reconstituted as a main-document forwarding origin.
  // openScopedFrontendView has already validated every module identity field.
  const attachment = mounted.resources;
  const View = mounted.component;
  function SelectedForwardingView(props: FrontendViewProps) {
    const scope = useContext(Context);
    if (!scope || scope.context.snapshot.hostId !== hostId)
      throw new Error("plugin.forwarding.expired");
    const owner = scope.owner;
    const committed = useRef<ReturnType<typeof createProviderLease> | null>(null);
    /* eslint-disable react-hooks/refs -- Gates retain callbacks, never read refs while rendering. */
    const gate = useMemo(() => {
      const lease = createProviderLease();
      const access = (mutation = true) => {
        live();
        if (lease.isClosed() || (mutation && committed.current !== lease))
          throw new Error("plugin.forwarding.expired");
        owner.check(mutation);
      };
      const write = () => {
        access();
        if (!selected.capabilities.write) throw new Error("plugin.forwarding.permissionDenied");
        if (!owner.service) throw new Error("panel.window.staleOwner");
      };
      const authority =
        owner.service && selected.capabilities.write
          ? owner.service.createProviderAuthority({ hostId, token: token!, client, check: write })
          : Object.freeze({
              authorize: write,
              origin: async () => {
                throw new Error("panel.window.unsupportedView");
              },
            });
      return { lease, access, authority };
    }, [owner]);
    /* eslint-enable react-hooks/refs */
    useLayoutEffect(() => {
      gate.lease.activate();
      committed.current = gate.lease;
      return () => {
        if (committed.current === gate.lease) committed.current = null;
        gate.lease.close();
      };
    }, [gate]);
    live();
    /* eslint-disable react-hooks/refs -- The guard stores callbacks without invoking them. */
    const forwarding = guardForwardingProvider(
      scope.context,
      gate.access,
      gate.authority,
      selected.capabilities.write && !!owner.service,
    );
    /* eslint-enable react-hooks/refs */
    return <View {...props} forwarding={forwarding} resources={attachment} />;
  }
  return { ...mounted, component: SelectedForwardingView };
}
