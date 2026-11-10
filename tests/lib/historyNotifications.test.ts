import { afterEach, expect, it, vi } from "vitest";
import { notifyHistoryChanged } from "@/lib/session/history";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});
it("preserves browser integrations but leaves native invalidation to the committed domain event", () => {
  const listener = vi.fn();
  window.addEventListener("tunnelde:history-changed", listener);
  try {
    notifyHistoryChanged("one");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ hostId: "one" });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    notifyHistoryChanged("one");
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("tunnelde:history-changed", listener);
  }
});
