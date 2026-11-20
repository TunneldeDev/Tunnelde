import { createResourceScope } from "@/lib/extensions/resourceScope";

export type AsyncPanelCapture = (signal: AbortSignal) => unknown | Promise<unknown>;
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
    pending: Promise<T> | undefined;
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
    async captureAsync(signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(new Error("panel.window.cancelled"));
      check();
      if (!pending) {
        const capturedRevision = revision;
        const selected = [...fields];
        pending = scope.run(
          async (work) => {
            const results = await Promise.allSettled(
              selected.map(
                async ([key, field]) =>
                  [key, field.async ? await field.async(work) : field.sync!()] as const,
              ),
            );
            // Wait for EVERY callback, even after one fails. Otherwise a slow,
            // cancellation-ignoring sibling could overlap the next capture.
            const failed = results.find((result) => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
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
              const results = await Promise.allSettled(
                [...fields.values()].map(async (field) => field.ready?.(work)),
              );
              check();
              if (work.aborted) throw new Error("panel.window.cancelled");
              const failed = results.find((result) => result.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
              // A real async renderer can register child fields at commit. Wait
              // for the new membership too, within the SAME overall deadline.
              if (generation === membership) return;
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
