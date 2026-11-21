import { useDialogs, type ConfirmOptions } from "@/store/dialogs";
/** Main-owned consent; a retired Settings page may neither create an orphan
 * prompt after show() nor leave an existing prompt holding its action fence. */
export async function confirmSettingsInMain(
  options: Omit<ConfirmOptions, "onConfirm">,
  show: () => Promise<unknown>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (useDialogs.getState().dialog.kind !== "none") throw new Error("market.busy");
  await show();
  signal.throwIfAborted();
  if (useDialogs.getState().dialog.kind !== "none") throw new Error("market.busy");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let stop = () => {};
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      stop();
      signal.removeEventListener("abort", cancel);
      resolve(value);
    };
    const cancel = () => {
      finish(false);
      if (useDialogs.getState().dialog === current) useDialogs.getState().close();
    };
    useDialogs.getState().confirm({ ...options, onConfirm: () => finish(true) });
    const current = useDialogs.getState().dialog;
    stop = useDialogs.subscribe((state) => {
      if (state.dialog !== current) finish(false);
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
