import { useForwardingReadModel, ignoreForwardingSubscription } from "./readScope";
import { diagnosticInvoke as invoke } from "@/lib/api/diagnosticInvoke";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/api/ipc";
import { createRetainedListStore } from "@/lib/data/retainedListStore";
import { domainEvents } from "@/lib/events/domain";
import { useSsh } from "@/store/ssh";

import type { ForwardInfo, RevisionedRule } from "../model/contract";
export type { ForwardInfo, ForwardRule } from "../model/contract";

/** One committed list and one native read for all forwarding surfaces. */
export function createForwardingStore(
  load: () => Promise<ForwardInfo[]>,
  observe: (refresh: () => void) => () => void,
) {
  const store = createRetainedListStore(load, observe);
  return Object.freeze({
    ...store,
    saved: (rule: RevisionedRule) => {
      const saved = Object.freeze({ ...rule, active: false, sessionId: null });
      store.accept((entries) => [...entries.filter((item) => item.id !== rule.id), saved]);
    },
  });
}
export const forwardingStore = createForwardingStore(
  () => (isTauri() ? invoke<ForwardInfo[]>("forwarding_list") : Promise.resolve([])),
  (refresh) => {
    const lifetime = new AbortController();
    void domainEvents.onForwards(refresh, lifetime.signal);
    const unsubscribe = useSsh.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) refresh();
    });
    return () => {
      lifetime.abort();
      unsubscribe();
    };
  },
);
export function useForwardingSnapshot() {
  const remote = useForwardingReadModel()?.rules;
  return useSyncExternalStore(
    remote ? ignoreForwardingSubscription : forwardingStore.subscribe,
    remote ? () => remote : forwardingStore.getSnapshot,
  );
}
