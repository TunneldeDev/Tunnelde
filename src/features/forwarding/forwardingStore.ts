import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/api/ipc";
import { createInvalidatedListStore } from "@/lib/data/invalidatedListStore";
import { domainEvents } from "@/lib/events/domain";
import { useSsh } from "@/store/ssh";

import type { ForwardInfo, ForwardRule } from "./contract";
export type { ForwardInfo, ForwardRule } from "./contract";

/** One committed list and one native read for all forwarding surfaces. */
export function createForwardingStore(
  load: () => Promise<ForwardInfo[]>,
  observe: (refresh: () => void) => () => void,
) {
  const store = createInvalidatedListStore(load, () => {});
  let clients = 0;
  let stop: (() => void) | undefined;
  return Object.freeze({
    ...store,
    subscribe: (receive: () => void) => {
      const unsubscribe = store.subscribe(receive);
      if (++clients === 1) {
        const unobserve = observe(store.refresh);
        const unstart = store.start();
        stop = () => {
          unobserve();
          unstart();
          store.reset();
        };
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        if (--clients === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
    saved: (rule: ForwardRule) => {
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
  return useSyncExternalStore(forwardingStore.subscribe, forwardingStore.getSnapshot);
}
