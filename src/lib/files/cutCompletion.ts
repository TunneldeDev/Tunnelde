import { useFileClipboard } from "@/store/fileClipboard";
import { useTransfers } from "@/store/transfers";

interface CutCompletion {
  id: string;
  seen: boolean;
  onDone: () => void;
  isRelevant: () => boolean;
}

const watches = new Set<CutCompletion>();
let unsubscribeTransfers: (() => void) | undefined;
let unsubscribeClipboard: (() => void) | undefined;
let checking = false;
let checkAgain = false;

function check(): void {
  // Completing one cut updates the clipboard synchronously. Reconcile that
  // change after this pass, rather than recursively notifying the same batch.
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  try {
    do {
      checkAgain = false;
      const items = new Map(useTransfers.getState().items.map((item) => [item.id, item]));
      for (const watch of [...watches]) {
        if (!watch.isRelevant()) {
          watches.delete(watch);
          continue;
        }
        const item = items.get(watch.id);
        if (!item) {
          if (watch.seen) watches.delete(watch);
          continue;
        }
        watch.seen = true;
        if (item.status === "done") {
          watches.delete(watch);
          watch.onDone();
        } else if (item.status === "cancelled" || item.status === "cleanupPending") {
          watches.delete(watch);
        }
      }
    } while (checkAgain);
  } finally {
    checking = false;
    if (watches.size === 0) {
      unsubscribeTransfers?.();
      unsubscribeClipboard?.();
      unsubscribeTransfers = undefined;
      unsubscribeClipboard = undefined;
    }
  }
}

/** Keep cut completion alive after a file view closes, using one shared listener. */
export function watchCutCompletion(
  id: string,
  onDone: () => void,
  isRelevant: () => boolean,
): void {
  if (!isRelevant()) return;
  watches.add({ id, seen: false, onDone, isRelevant });
  if (!unsubscribeTransfers) {
    unsubscribeTransfers = useTransfers.subscribe(check);
    unsubscribeClipboard = useFileClipboard.subscribe(check);
  }
  check();
}
