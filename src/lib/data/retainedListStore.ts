import { createInvalidatedListStore } from "./invalidatedListStore";

/** Shared read lifetime. Zero consumers retire observation and invalidate late
 * reads; mounting another presentation never starts a second concurrent reader. */
export function createRetainedListStore<T>(
  load: () => Promise<T[]>,
  observe: (refresh: () => void) => () => void,
) {
  const store = createInvalidatedListStore(load, () => {});
  let clients = 0;
  let stop: (() => void) | undefined;
  return Object.freeze({
    ...store,
    subscribe(receive: () => void) {
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
  });
}
