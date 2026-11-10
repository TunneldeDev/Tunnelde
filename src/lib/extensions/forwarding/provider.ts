import type { FrontendForwarding } from "../contracts/forwarding/provider";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { ForwardingContext } from "./context";
import type { ForwardingAuthority } from "./authority";

export function guardForwardingProvider(
  context: ForwardingContext & Pick<FrontendForwarding, "Entries">,
  checkAccess: CheckProviderAccess,
  authority: ForwardingAuthority,
  canWrite: boolean,
): FrontendForwarding {
  const write = () => authority.authorize();
  return Object.freeze<FrontendForwarding>({
    Entries: context.Entries,
    snapshot: context.snapshot,
    capabilities: Object.freeze({ write: canWrite }),
    read: (request) => {
      checkAccess(false);
      return context.read(request);
    },
    refresh: () => {
      checkAccess();
      context.refresh();
    },
    start: (id) => {
      write();
      context.start(id, authority);
    },
    startAll: () => {
      write();
      context.startAll(authority);
    },
    stop: (id) => {
      write();
      context.stop(id, authority);
    },
    requestAdd: () => {
      write();
      context.requestAdd(authority);
    },
    requestEdit: (id) => {
      write();
      context.requestEdit(id, authority);
    },
    requestRemove: (id) => {
      write();
      context.requestRemove(id, authority);
    },
    requestDisconnect: () => {
      write();
      context.requestDisconnect(authority);
    },
  });
}
