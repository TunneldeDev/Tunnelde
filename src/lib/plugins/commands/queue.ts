import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { samePluginRuntime } from "./runtime";

const MAX_PLUGINS = 64;
const MAX_ACTIONS = 32;
interface Item {
  run(signal: AbortSignal): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
interface Queue {
  running?: PluginInfo;
  items: Item[];
  active: boolean;
  cancelled: boolean;
  controller: AbortController;
  cancelWait(): void;
  cancelledWait: Promise<void>;
  unsubscribe(): void;
}
const queues = new Map<string, Queue>();

function cancel(id: string, queue: Queue) {
  if (queue.cancelled) return;
  queue.cancelled = true;
  queue.controller.abort();
  queue.unsubscribe();
  queue.cancelWait();
  for (const item of queue.items.splice(0)) item.resolve();
  if (queues.get(id) === queue) queues.delete(id);
}

/** Contributed actions serialize per runtime. Chat control requests keep their
 * own concurrent transport, so a stop command never waits behind a response. */
export function enqueuePluginAction(
  original: PluginInfo,
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const id = original.id;
  if (usePlugins.getState().stoppingIds.includes(id)) return Promise.resolve();
  let queue = queues.get(id);
  if (!queue) {
    if (queues.size >= MAX_PLUGINS) return Promise.reject(new Error("plugin.api.busy"));
    let cancelWait!: () => void;
    const cancelledWait = new Promise<void>((resolve) => {
      cancelWait = resolve;
    });
    queue = {
      running: original.status === "running" ? original : undefined,
      items: [],
      active: false,
      cancelled: false,
      controller: new AbortController(),
      cancelWait,
      cancelledWait,
      unsubscribe: () => {},
    };
    const owned = queue;
    queues.set(id, queue);
    queue.unsubscribe = usePlugins.subscribe((state) => {
      const current = state.items.find((item) => item.id === id);
      if (
        state.stoppingIds.includes(id) ||
        !current ||
        current.status === "failed" ||
        current.version !== original.version ||
        current.fingerprint !== original.fingerprint ||
        (owned.running && !samePluginRuntime(current, owned.running))
      ) {
        cancel(id, owned);
      } else if (current.status === "running") {
        owned.running ??= current;
      }
    });
  }
  if (queue.items.length + Number(queue.active) >= MAX_ACTIONS)
    return Promise.reject(new Error("plugin.api.busy"));
  const owned = queue;
  const result = new Promise<void>((resolve, reject) => {
    owned.items.push({ run, resolve, reject });
  });
  if (!queue.active) {
    queue.active = true;
    void (async () => {
      try {
        while (!owned.cancelled) {
          const item = owned.items.shift();
          if (!item) break;
          try {
            await Promise.race([
              Promise.resolve().then(() => {
                if (!owned.cancelled) return item.run(owned.controller.signal);
              }),
              owned.cancelledWait,
            ]);
            item.resolve();
          } catch (error) {
            item.reject(error);
          }
        }
      } finally {
        cancel(id, owned);
      }
    })();
  }
  return result;
}
