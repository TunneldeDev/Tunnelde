import { useForwardingReadModel, ignoreForwardingSubscription } from "./readScope";
import { diagnosticInvoke as invoke } from "@/lib/api/diagnosticInvoke";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/api/ipc";
import { createRetainedListStore } from "@/lib/data/retainedListStore";
import { domainEvents } from "@/lib/events/domain";
import type { ForwardGroup } from "../model/contract";

/** Same owner across host details and the global panel. Empty groups are data,
 * not inferred from forwarding rules; callers select their host explicitly. */
export const forwardingGroupsStore = createRetainedListStore(
  () => (isTauri() ? invoke<ForwardGroup[]>("forwarding_groups_list") : Promise.resolve([])),
  (refresh) => {
    const lifetime = new AbortController();
    void domainEvents.onForwards(refresh, lifetime.signal);
    return () => lifetime.abort();
  },
);
export function useForwardingGroupsSnapshot() {
  const remote = useForwardingReadModel()?.groups;
  return useSyncExternalStore(
    remote ? ignoreForwardingSubscription : forwardingGroupsStore.subscribe,
    remote ? () => remote : forwardingGroupsStore.getSnapshot,
  );
}
