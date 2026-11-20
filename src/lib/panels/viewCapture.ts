import { PanelStateLossRequired, type PanelCaptureOptions } from "./stateLoss";
import { createResourceScope } from "@/lib/extensions/resourceScope";

export type AsyncPanelCapture = (
  signal: AbortSignal,
  options?: PanelCaptureOptions,
) => unknown | Promise<unknown>;
export type PanelReady = (signal: AbortSignal) => void | Promise<void>;
interface Field {
  sync?: () => unknown;
  async?: AsyncPanelCapture;
  ready?: PanelReady;
}
/** Bound the caller's wait without releasing the underlying capture reservation.
 * Plugin JavaScript may ignore cancellation; do not start duplicate work then. */
export function awaitPanelWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Error("panel.window.cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("panel.window.cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** Ephemeral UI snapshots, not plugin activation or business-resource ownership. */
export function createPanelCaptures<T>(
  maxFields: number,
  clone: (fields: Record<string, unknown>) => T,
) {
  const fields = new Map<string, Field>();
  const scope = createResourceScope({ limit: 1 });
  let membership = 0,
    revision = 0,
    pending: Promise<T> | undefined,
    pendingOptions: PanelCaptureOptions["consentedStateLoss"];
  const check = (size = true) => {
    if (scope.signal.aborted) throw new Error("panel.viewState.disposed");
    if (size && fields.size > maxFields) throw new Error("panel.viewState.tooManyFields");
  };
  return {
    invalidate() {
      revision++;
    },
    register(key: string, field: Field) {
      check(false);
      if (fields.has(key)) throw new Error("panel.viewState.duplicateKey");
      fields.set(key, field);
      membership++;
      revision++;
      return () => {
        if (fields.get(key) !== field) return false;
        fields.delete(key);
        membership++;
        revision++;
        return true;
      };
    },
    capture() {
      check();
      return clone(
        Object.fromEntries(
          [...fields].map(([key, field]) => {
            if (!field.sync) throw new Error("panel.viewState.asyncRequired");
            return [key, field.sync()];
          }),
        ),
      );
    },
    async captureAsync(signal?: AbortSignal, options?: PanelCaptureOptions): Promise<T> {
      if (signal?.aborted) return Promise.reject(new Error("panel.window.cancelled"));
      check();
      if (pending && pendingOptions !== options?.consentedStateLoss)
        throw new Error("panel.window.moveInProgress");
      if (!pending) {
        pendingOptions = options?.consentedStateLoss;
        const capturedRevision = revision;
        const selected = [...fields];
        pending = scope.run(
          async (work) => {
            const results = await Promise.allSettled(
              selected.map(
                async ([key, field]) =>
                  [key, field.async ? await field.async(work, options) : field.sync!()] as const,
              ),
            );
            // Wait for EVERY callback, even after one fails. Otherwise a slow,
            // cancellation-ignoring sibling could overlap the next capture.
            const failures = results.filter((result) => result.status === "rejected");
            const failed = failures.find(
              (result) => !(result.reason instanceof PanelStateLossRequired),
            );
            if (failed) throw failed.reason;
            if (failures.length)
              throw new PanelStateLossRequired(
                failures.flatMap((result) => (result.reason as PanelStateLossRequired).views),
              );
            const values = results.map((result) => {
              if (result.status !== "fulfilled") throw new Error("panel.viewState.invalid");
              return result.value;
            });
            check();
            if (work.aborted) throw new Error("panel.window.cancelled");
            if (capturedRevision !== revision)
              throw new Error("panel.viewState.changedDuringCapture");
            return clone(Object.fromEntries(values));
          },
          { timeoutMs: 15_000 },
        );
        const current = pending;
        void current
          .finally(() => {
            if (pending === current) pending = undefined;
          })
          .catch(() => {});
      }
      return awaitPanelWork(pending, signal);
    },
    hasReadiness: () => [...fields.values()].some((field) => !!field.ready),
    async waitReady(signal: AbortSignal) {
      check();
      const wait = createResourceScope({ parent: scope.signal, limit: 1 });
      try {
        await wait.run(
          async (work) => {
            for (;;) {
              const generation = membership;
              const selected = [...fields];
              const results = await Promise.allSettled(
                selected.map(async ([, field]) => field.ready?.(work)),
              );
              check();
              if (work.aborted) throw new Error("panel.window.cancelled");
              // StrictMode and async factories may retire a spinner/readiness
              // binding while this wait is in flight. Its cancellation is not
              // failure of the replacement renderer. Re-read membership first;
              // the SAME overall deadline still bounds churn and all live errors.
              const removedFailure = results.some(
                (result, index) =>
                  result.status === "rejected" && !fields.get(selected[index]![0])?.ready,
              );
              if (generation !== membership && !removedFailure) continue;
              const failed = results.find((result) => result.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
              return;
            }
          },
          { signal, timeoutMs: 15_000 },
        );
      } finally {
        wait.dispose();
      }
    },
    dispose() {
      scope.dispose();
      fields.clear();
      membership++;
      revision++;
    },
  };
}
