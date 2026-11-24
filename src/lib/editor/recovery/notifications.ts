import { presentError } from "@/lib/api/errors";
import { toast, useToasts } from "@/store/toasts";

// The ordered writer rejects its waiters with the same failure object. Only
// that failure's currently visible recovery notice is shared; unrelated tasks
// and errors with identical text still report independently.
const notices = new WeakMap<object, string>();

export function reportDraftRecoveryFailure(error: unknown): void {
  const failure = typeof error === "object" && error !== null ? error : undefined;
  const previous = failure && notices.get(failure);
  if (previous && useToasts.getState().items.some((item) => item.id === previous)) return;
  toast(presentError(error), "error");
  const notice = useToasts.getState().items.at(-1);
  if (failure && notice) notices.set(failure, notice.id);
}
