import { afterEach, expect, it, vi } from "vitest";
import { confirmPanelStateLoss } from "@/lib/panels/stateLossConsent";
import { useDialogs } from "@/store/dialogs";
const views = [{ pluginId: "example", viewId: "files" }];
afterEach(() => {
  useDialogs.getState().close();
  vi.useRealTimers();
});
it("requires explicit consent and closes only its own dialog", async () => {
  const pending = confirmPanelStateLoss(views, () => true);
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind !== "confirm") throw new Error("missing confirmation");
  expect(dialog.danger).toBe(true);
  expect(dialog.focusCancel).toBe(true);
  await dialog.onConfirm();
  expect(await pending).toBe(true);
  expect(useDialogs.getState().dialog.kind).toBe("none");
});
it("denies cancellation and does not reuse old consent", async () => {
  const pending = confirmPanelStateLoss(views, () => true);
  useDialogs.getState().close();
  expect(await pending).toBe(false);
  const next = confirmPanelStateLoss(views, () => true);
  expect(useDialogs.getState().dialog.kind).toBe("confirm");
  useDialogs.getState().close();
  expect(await next).toBe(false);
});
it("does not replace another dialog or close its replacement", async () => {
  useDialogs.getState().openHost();
  await expect(confirmPanelStateLoss(views, () => true)).rejects.toThrow("dialog.busy");
  expect(useDialogs.getState().dialog.kind).toBe("host");
  useDialogs.getState().close();
  const pending = confirmPanelStateLoss(views, () => true);
  useDialogs.getState().openGroup();
  expect(await pending).toBe(false);
  expect(useDialogs.getState().dialog.kind).toBe("group");
});
it("aborts or dismisses a retired renderer and ignores late confirm", async () => {
  vi.useFakeTimers();
  let valid = true;
  const pending = confirmPanelStateLoss(views, () => valid);
  const dialog = useDialogs.getState().dialog;
  valid = false;
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toBe(false);
  if (dialog.kind === "confirm") await dialog.onConfirm();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  const abort = new AbortController();
  const next = confirmPanelStateLoss(views, () => true, abort.signal);
  abort.abort();
  expect(await next).toBe(false);
});

it.each(["accept", "dismiss", "replace"] as const)(
  "handles synchronous dialog-store subscriber %s without leaking or hanging",
  async (action) => {
    vi.useFakeTimers();
    let observed = false;
    const stop = useDialogs.subscribe(({ dialog }) => {
      if (observed || dialog.kind !== "confirm") return;
      observed = true;
      if (action === "accept") void dialog.onConfirm();
      else if (action === "dismiss") useDialogs.getState().close();
      else useDialogs.getState().openGroup();
    });
    try {
      expect(await confirmPanelStateLoss(views, () => true)).toBe(action === "accept");
      expect(useDialogs.getState().dialog.kind).toBe(action === "replace" ? "group" : "none");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop();
    }
  },
);
