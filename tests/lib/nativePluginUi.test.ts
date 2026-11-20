import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startNativePluginUi, type NativePluginUiPrompt } from "@/lib/panels/windowPluginUi";
import { useDialogs } from "@/store/dialogs";
import "@/i18n/i18n";
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/store/toasts", () => ({ toast }));
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  useDialogs.getState().close();
  toast.mockClear();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  useDialogs.getState().close();
  vi.useRealTimers();
});
function fixture() {
  let prompts: NativePluginUiPrompt[] = [],
    changed = () => {};
  const unlisten = vi.fn();
  const client = {
    listPluginUi: vi.fn(async () => prompts),
    replyPluginUi: vi.fn(async (_id: string, _value: boolean | null, _error?: string) => {}),
    subscribe: vi.fn(async (receive: () => void) => {
      changed = receive;
      return unlisten;
    }),
  };
  const failure = vi.fn();
  const stop = startNativePluginUi(client, failure);
  stops.push(stop);
  return {
    client,
    failure,
    stop,
    unlisten,
    set: (items: NativePluginUiPrompt[]) => {
      prompts = items;
      changed();
    },
  };
}
const confirm = (id = "one"): NativePluginUiPrompt => ({
  id,
  pluginId: "sample",
  message: "Trust this operation?",
  method: "ui.confirm",
});
function approve() {
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("missing confirm");
  return dialog.onConfirm();
}
it("shows once, approves only once and does not repeat a still-listed prompt", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  const dialog = useDialogs.getState().dialog;
  expect(dialog).toMatchObject({
    kind: "confirm",
    body: "Trust this operation?",
    preformatted: true,
  });
  const callback = dialog.kind === "confirm" ? dialog.onConfirm : () => {};
  await callback();
  await callback();
  f.set([confirm()]);
  await settle();
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", true, undefined);
  expect(useDialogs.getState().dialog.kind).toBe("none");
});
it("replies false on cancellation and cannot approve the stale callback", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  const dialog = useDialogs.getState().dialog;
  useDialogs.getState().close();
  await settle();
  if (dialog.kind === "confirm") await dialog.onConfirm();
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", false, undefined);
});
it("never replaces an existing host dialog and reports busy", async () => {
  const f = fixture();
  await settle();
  useDialogs
    .getState()
    .confirm({ title: "Host", body: "User task", confirmLabel: "OK", onConfirm() {} });
  const original = useDialogs.getState().dialog;
  f.set([confirm()]);
  await settle();
  expect(useDialogs.getState().dialog).toBe(original);
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", false, "dialog.busy");
});
it("does not dismiss a replacement dialog after its own callback settles", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  const old = useDialogs.getState().dialog;
  useDialogs
    .getState()
    .confirm({ title: "Replacement", body: "Next", confirmLabel: "OK", onConfirm() {} });
  const next = useDialogs.getState().dialog;
  if (old.kind === "confirm") await old.onConfirm();
  expect(useDialogs.getState().dialog).toBe(next);
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", false, undefined);
});
it("withdraws revoked or expired prompts without sending approval", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  const old = useDialogs.getState().dialog;
  f.set([]);
  await settle();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  if (old.kind === "confirm") await old.onConfirm();
  expect(f.client.replyPluginUi).not.toHaveBeenCalled();
});
it("fails closed on refresh loss and ignores an old approval", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  const old = useDialogs.getState().dialog;
  f.client.listPluginUi.mockRejectedValueOnce(Error("authority expired"));
  f.set([confirm()]);
  await settle();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  if (old.kind === "confirm") await old.onConfirm();
  expect(f.client.replyPluginUi).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledOnce();
});
it("coalesces notifications during a slow list and serializes refreshes", async () => {
  const f = fixture();
  await settle();
  let finish!: (items: NativePluginUiPrompt[]) => void;
  f.client.listPluginUi.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const before = f.client.listPluginUi.mock.calls.length;
  f.set([confirm()]);
  f.set([confirm()]);
  f.set([confirm()]);
  await settle();
  expect(f.client.listPluginUi.mock.calls.length).toBe(before + 1);
  finish([confirm()]);
  await settle();
  expect(f.client.listPluginUi.mock.calls.length).toBe(before + 2);
  expect(useDialogs.getState().dialog.kind).toBe("confirm");
});
it("emits a message once and replies null without opening a dialog", async () => {
  const f = fixture();
  await settle();
  const message: NativePluginUiPrompt = {
    id: "msg",
    pluginId: "sample",
    method: "ui.showMessage",
    message: "Done",
    kind: "success",
  };
  f.set([message]);
  await settle();
  f.set([message]);
  await settle();
  expect(toast).toHaveBeenCalledOnce();
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("msg", null, undefined);
  expect(useDialogs.getState().dialog.kind).toBe("none");
});
it("dispose cancels the active prompt once and ignores late refreshes", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  f.stop();
  f.stop();
  await settle();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", false, undefined);
  f.set([confirm("late")]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(useDialogs.getState().dialog.kind).toBe("none");
  expect(f.unlisten).toHaveBeenCalledOnce();
});
it("does not re-show a pending reply across transient empty snapshots", async () => {
  const f = fixture();
  await settle();
  f.set([confirm()]);
  await settle();
  let done!: () => void;
  f.client.replyPluginUi.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const pending = approve();
  f.set([]);
  await settle();
  f.set([confirm()]);
  await settle();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  done();
  await pending;
  expect(f.client.replyPluginUi).toHaveBeenCalledOnce();
});
it("removes a late subscription after disposal without polling again", async () => {
  let subscribe!: (stop: () => void) => void;
  const client = {
    listPluginUi: vi.fn(async () => []),
    replyPluginUi: vi.fn(async () => {}),
    subscribe: vi.fn(
      () =>
        new Promise<() => void>((done) => {
          subscribe = done;
        }),
    ),
  };
  const stop = startNativePluginUi(client, vi.fn());
  stops.push(stop);
  stop();
  const unlisten = vi.fn();
  subscribe(unlisten);
  await settle();
  expect(unlisten).toHaveBeenCalledOnce();
  const before = client.listPluginUi.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(client.listPluginUi.mock.calls.length).toBe(before);
});
it("renders host-only force consent with danger styling and Cancel as default", async () => {
  const f = fixture();
  await settle();
  f.set([{ ...confirm(), method: "__mounts.forceUnmount" }]);
  await settle();
  expect(useDialogs.getState().dialog).toMatchObject({
    kind: "confirm",
    danger: true,
    focusCancel: true,
    confirmLabel: "Force unmount",
  });
  useDialogs.getState().close();
  await settle();
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", false, undefined);
});
it.each(["ui.confirm", "__mounts.forceUnmount"] as const)(
  "%s settles synchronous acceptance, dismissal, replacement and disposal exactly once",
  async (method) => {
    for (const action of ["accept", "dismiss", "replace", "dispose"] as const) {
      const f = fixture();
      await settle();
      let old: (() => void | Promise<void>) | undefined;
      const unsubscribe = useDialogs.subscribe(({ dialog }) => {
        if (dialog.kind !== "confirm" || old) return;
        old = dialog.onConfirm;
        if (action === "accept") void dialog.onConfirm();
        if (action === "dismiss") useDialogs.getState().close();
        if (action === "replace") useDialogs.getState().openGroup();
        if (action === "dispose") f.stop();
      });
      f.set([{ ...confirm(), method }]);
      await settle();
      unsubscribe();
      expect(old).toBeDefined();
      expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith(
        "one",
        action === "accept",
        undefined,
      );
      expect(useDialogs.getState().dialog.kind).toBe(action === "replace" ? "group" : "none");
      // Even a captured callback cannot approve dismissed, replaced or disposed UI.
      await old?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.client.replyPluginUi).toHaveBeenCalledOnce();
      f.stop();
      useDialogs.getState().close();
    }
  },
);
it("stops processing a fetched batch when a synchronous subscriber disposes the host", async () => {
  const f = fixture();
  await settle();
  let stopped = false;
  const unsubscribe = useDialogs.subscribe(({ dialog }) => {
    if (dialog.kind === "confirm" && !stopped) {
      stopped = true;
      f.stop();
    }
  });
  f.set([
    confirm(),
    {
      id: "late-message",
      pluginId: "sample",
      method: "ui.showMessage",
      message: "Late",
      kind: "info",
    },
  ]);
  await settle();
  unsubscribe();
  expect(toast).not.toHaveBeenCalled();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  expect(f.client.replyPluginUi).toHaveBeenCalledExactlyOnceWith("one", false, undefined);
});
