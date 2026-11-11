import type {
  FrontendBackgroundTaskContext,
  FrontendBackgroundTaskRunner,
} from "../contracts/backgroundTasks/execution";
import { runBackgroundTask } from "@/lib/tasks/execution";

const text = (value: unknown, limit: number, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()))
    throw new Error("plugin.backgroundTasks.invalid");
  return value;
};

/** Own work only. Never expose the global registry through the execution facade. */
export function createBackgroundTaskRunner(
  lifetime: AbortSignal,
  live: () => void,
  pluginId: string,
): FrontendBackgroundTaskRunner {
  let pending = 0;
  return Object.freeze<FrontendBackgroundTaskRunner>({
    async run(options, work) {
      live();
      if (lifetime.aborted) throw new Error("extension.scope.closed");
      if (!options || typeof options !== "object" || typeof work !== "function")
        throw new Error("plugin.backgroundTasks.invalid");
      const title = text(options.title, 512, true)!;
      if (
        (options.visible !== undefined && typeof options.visible !== "boolean") ||
        (options.cancellable !== undefined && typeof options.cancellable !== "boolean") ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      )
        throw new Error("plugin.backgroundTasks.invalid");
      if (pending >= 8) throw new Error("plugin.backgroundTasks.limit");
      const callerSignal = options.signal;
      const controller = new AbortController();
      const abortRuntime = () => controller.abort(lifetime.reason);
      const abortCaller = () => controller.abort(callerSignal?.reason);
      lifetime.addEventListener("abort", abortRuntime, { once: true });
      callerSignal?.addEventListener("abort", abortCaller, { once: true });
      if (callerSignal?.aborted) abortCaller();
      if (lifetime.aborted) abortRuntime();
      pending++;
      try {
        return await runBackgroundTask(
          {
            title,
            visible: options.visible,
            cancellable: options.cancellable,
            signal: controller.signal,
            pluginId,
          },
          async (context) => {
            let settled = false;
            try {
              const result = await work(
                Object.freeze({
                  signal: context.signal,
                  report(update: Parameters<FrontendBackgroundTaskContext["report"]>[0]) {
                    live();
                    if (settled || context.signal.aborted)
                      throw new Error("plugin.backgroundTasks.inactive");
                    if (!update || typeof update !== "object")
                      throw new Error("plugin.backgroundTasks.invalid");
                    const message = text(update.message, 4096);
                    const p = update.progress;
                    if (
                      p !== undefined &&
                      (!p ||
                        typeof p !== "object" ||
                        !Number.isFinite(p.completed) ||
                        p.completed < 0 ||
                        (p.total != null && (!Number.isFinite(p.total) || p.total < 0)) ||
                        (p.unit !== undefined && !["bytes", "items", "percent"].includes(p.unit)))
                    )
                      throw new Error("plugin.backgroundTasks.invalid");
                    context.report({
                      ...(message !== undefined ? { message } : {}),
                      ...(p !== undefined
                        ? { progress: { completed: p.completed, total: p.total, unit: p.unit } }
                        : {}),
                    });
                  },
                }),
              );
              context.signal.throwIfAborted();
              live();
              return result;
            } finally {
              settled = true;
            }
          },
        );
      } finally {
        pending--;
        lifetime.removeEventListener("abort", abortRuntime);
        callerSignal?.removeEventListener("abort", abortCaller);
      }
    },
  });
}
