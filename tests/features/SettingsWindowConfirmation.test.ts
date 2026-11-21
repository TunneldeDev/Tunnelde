import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmSettingsInMain } from "@/features/settings/window/confirmation";
import { useDialogs } from "@/store/dialogs";
const options = { title: "Permission", body: "Change configuration?", confirmLabel: "Accept" };
beforeEach(() => useDialogs.getState().close());
describe("main Settings consent lifecycle", () => {
  it("waits for the actual main prompt decision", async () => {
    const show = vi.fn(async () => {});
    const result = confirmSettingsInMain(options, show, new AbortController().signal);
    await Promise.resolve();
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind !== "confirm") throw new Error("missing prompt");
    await dialog.onConfirm();
    expect(await result).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
  it("cancels only its own prompt when the originating owner closes", async () => {
    const controller = new AbortController();
    const result = confirmSettingsInMain(options, async () => {}, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await result).toBe(false);
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });
  it("cannot create an orphan prompt after asynchronous window activation", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const result = confirmSettingsInMain(
      options,
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      controller.signal,
    );
    controller.abort();
    ready();
    await expect(result).rejects.toThrow();
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });
  it("does not overwrite or close another active dialog", async () => {
    const controller = new AbortController();
    const result = confirmSettingsInMain(options, async () => {}, controller.signal);
    await Promise.resolve();
    useDialogs.getState().openHost();
    controller.abort();
    expect(await result).toBe(false);
    expect(useDialogs.getState().dialog.kind).toBe("host");
    await expect(
      confirmSettingsInMain(options, async () => {}, new AbortController().signal),
    ).rejects.toThrow("market.busy");
  });
});
