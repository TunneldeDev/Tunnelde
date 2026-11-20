import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { useFilePreview } from "@/store/filePreview";
import { usePanelPresentations } from "@/store/panelPresentation";
import { panelSnapshot } from "./snapshot";

const epoch = crypto.randomUUID();
let sequence = 0;
let serialized = "";

/** Local source-layout observation only; public RPC revisions live natively. */
export function panelsSnapshot() {
  const panels = panelSnapshot();
  const next = JSON.stringify(panels);
  if (next !== serialized) {
    serialized = next;
    sequence++;
  }
  return { revision: `${epoch}:${sequence}`, windowId: "main", panels };
}

/** Coalesce compound store transactions; only layout metadata can invalidate this stream. */
export function subscribePanels(changed: () => void) {
  let previous = panelsSnapshot().revision;
  let queued = false;
  let disposed = false;
  const check = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      const current = panelsSnapshot().revision;
      if (current !== previous) {
        previous = current;
        changed();
      }
    });
  };
  const cleanups = [
    useWorkspace.subscribe(check),
    useNavigation.subscribe(check),
    usePlugins.subscribe(check),
    useFilePreview.subscribe(check),
    usePanelPresentations.subscribe(check),
  ];
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
  };
}

/** Bounded long-poll for RPC plugins; cancellation never leaves subscriptions behind. */
export function observePanels(revision?: string, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new Error("requestCancelled"));
  const current = panelsSnapshot();
  if (revision !== current.revision) return Promise.resolve(current);
  return new Promise<ReturnType<typeof panelsSnapshot>>((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve(panelsSnapshot());
    };
    const abort = () => {
      cleanup();
      reject(new Error("requestCancelled"));
    };
    const unsubscribe = subscribePanels(finish);
    const timer = window.setTimeout(finish, 10_000);
    const cleanup = () => {
      unsubscribe();
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
