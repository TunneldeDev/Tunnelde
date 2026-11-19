import type { PanelWindowClient } from "./windowClient";
import type { PanelMoveJob } from "./windowProtocol";
import { movePanelToWindow } from "./windowMoves";

/** View-only source executor. The opaque job is native-bound to exact source,
 * destination and plugin lease; no plugin token or arbitrary command is relayed.
 * The native caller waits for actual handoff commit, not this JS task's return.
 */
export function startPanelMoveRequests(
  client: PanelWindowClient,
  failure: (error: unknown) => void,
) {
  let disposed = false,
    queued = false,
    running = false;
  let unsubscribe: (() => void) | undefined;
  const active = new Set<string>();
  const report = (error: unknown) => {
    try {
      failure(error);
    } catch {
      // A diagnostic callback must not prevent native reservation cleanup.
    }
  };
  const execute = async (job: PanelMoveJob) => {
    active.add(job.id);
    try {
      if (disposed) return;
      await movePanelToWindow(job.lease.panelId, job.targetWindow, job.lease, job.id);
    } catch (error) {
      if (!disposed) report(error);
    } finally {
      // Success already consumed the native job. Late finalization is harmless;
      // cancellation/capture failure must release the still-pending reservation.
      await client.failPanelMove(job.id).catch(() => {});
      active.delete(job.id);
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
          const jobs = await client.claimPanelMoves();
          // Claims can settle after unsubscribe/disposal. Execute's finally
          // releases them without starting a capture in the retired document.
          for (const job of jobs) void execute(job);
        }
      } catch (error) {
        if (!disposed) report(error);
      } finally {
        running = false;
      }
    })();
  };
  void client.subscribe(refresh).then(
    (stop) => {
      if (disposed) stop();
      else {
        unsubscribe = stop;
        refresh();
      }
    },
    (error) => {
      if (!disposed) report(error);
    },
  );
  return () => {
    disposed = true;
    queued = false;
    unsubscribe?.();
    for (const id of active) void client.failPanelMove(id).catch(() => {});
  };
}
