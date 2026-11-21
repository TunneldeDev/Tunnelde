import type { PanelWindowClient } from "./windowClient";
import type { PanelActionJob } from "./windowProtocol";

/** Resource effects remain in the main document. Native claim is the final
 * admission boundary; jobs are never replayed after reload or partial failure. */
export function startWindowActions(
  client: PanelWindowClient,
  execute: (job: PanelActionJob) => Promise<unknown>,
  failure: (error: unknown) => void,
) {
  if (client.windowId !== "main") throw new Error("panel.window.coordinatorRequired");
  let disposed = false,
    queued = false,
    running = false;
  let unsubscribe: (() => void) | undefined;
  const run = async (job: PanelActionJob) => {
    try {
      if (disposed) {
        await client.finalizeAction(job.id, { status: "failed", message: "panel.window.disposed" });
        return;
      }
      let result;
      try {
        result = { status: "done" as const, value: (await execute(job)) ?? null };
      } catch (error) {
        result = {
          status: "failed" as const,
          message: String(error instanceof Error ? error.message : error).slice(0, 4096),
        };
      }
      await client.finalizeAction(job.id, result);
    } catch (error) {
      if (!disposed) failure(error);
    }
  };
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          const jobs = await client.claimActions();
          // Dispatch independently: one slow source must not block another
          // panel, and the native queue/feature registries bound concurrency.
          for (const job of jobs) void run(job);
        }
      } catch (error) {
        if (!disposed) failure(error);
      } finally {
        running = false;
      }
    })();
  };
  const ready = client
    .subscribe(refresh)
    .then((stop) => {
      if (disposed) stop();
      else {
        unsubscribe = stop;
        refresh();
      }
    })
    .catch((error) => {
      if (!disposed) failure(error);
    });
  return {
    ready,
    refresh,
    dispose() {
      disposed = true;
      unsubscribe?.();
    },
  };
}
