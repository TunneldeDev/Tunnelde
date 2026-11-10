import type { PluginInfo } from "@/lib/api/types";
import { isTauri } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";

export class PluginInvocationCancelled extends Error {
  constructor() {
    super("plugin.invocation.cancelled");
    this.name = "PluginInvocationCancelled";
  }
}

export const isPluginInvocationCancelled = (error: unknown) =>
  error instanceof PluginInvocationCancelled;

export function samePluginRuntime(current: PluginInfo | undefined, original: PluginInfo) {
  return (
    !!current &&
    current.status === "running" &&
    current.id === original.id &&
    current.version === original.version &&
    current.fingerprint === original.fingerprint &&
    current.runtimeId === original.runtimeId
  );
}

/** Capture before consent or transport waits. The native host independently
 * validates this identity; this scope only cancels UI waits and late results. */
export async function withPluginInvocation<T>(
  original: PluginInfo | undefined,
  action: (plugin: PluginInfo, signal: AbortSignal, check: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!original || original.status !== "running") throw new Error("plugin.notRunning");
  if (isTauri() && !original.runtimeId) throw new Error("pluginSecurity.changed");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const check = () => {
    const state = usePlugins.getState();
    if (
      signal?.aborted ||
      controller.signal.aborted ||
      state.stoppingIds.includes(original.id) ||
      !samePluginRuntime(
        state.items.find((item) => item.id === original.id),
        original,
      )
    )
      throw new PluginInvocationCancelled();
  };
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const onAbort = () => reject(new PluginInvocationCancelled());
  controller.signal.addEventListener("abort", onAbort, { once: true });
  signal?.addEventListener("abort", abort, { once: true });
  const unsubscribe = usePlugins.subscribe(() => {
    try {
      check();
    } catch {
      abort();
    }
  });
  try {
    // Both branches have rejection handlers before any user code can run.
    return await Promise.race([
      (async () => {
        check();
        const result = await action(original, controller.signal, check);
        check();
        return result;
      })(),
      cancelled,
    ]);
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
