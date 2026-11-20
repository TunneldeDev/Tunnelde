import i18n from "@/i18n/i18n";
import { useDialogs } from "@/store/dialogs";
import type { PanelStateLoss } from "./stateLoss";

/** One attempt only. Dismissal, replacement, retirement and abort all deny.
 * Consent is neither persisted nor inferred from the translated error text. */
export function confirmPanelStateLoss(
  views: readonly PanelStateLoss[],
  valid: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted || !valid()) return Promise.resolve(false);
  if (useDialogs.getState().dialog.kind !== "none") return Promise.reject(new Error("dialog.busy"));
  return new Promise((resolve) => {
    let stop = () => {};
    let finished = false;
    const settle = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      stop();
      clearInterval(timer);
      signal?.removeEventListener("abort", cancel);
      const current = useDialogs.getState().dialog;
      if (current.kind === "confirm" && current.onConfirm === accept) useDialogs.getState().close();
      resolve(accepted && !signal?.aborted && valid());
    };
    const cancel = () => settle(false);
    const accept = () => settle(true);
    const timer = setInterval(() => {
      if (!valid()) cancel();
    }, 200);
    useDialogs.getState().confirm({
      title: i18n.t("panels.stateLossTitle"),
      body: i18n.t("panels.stateLossBody", {
        views: [...new Set(views.map((view) => `${view.pluginId} / ${view.viewId}`))].join(", "),
      }),
      confirmLabel: i18n.t("panels.stateLossConfirm"),
      danger: true,
      focusCancel: true,
      onConfirm: accept,
    });
    // Store subscribers may synchronously accept, dismiss or replace the
    // dialog while confirm() publishes it. Never leave a waiter or timer behind.
    if (finished) return;
    const dialog = useDialogs.getState().dialog;
    if (dialog.kind !== "confirm" || dialog.onConfirm !== accept) {
      cancel();
      return;
    }
    stop = useDialogs.subscribe((state) => {
      if (state.dialog !== dialog) cancel();
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted || !valid()) cancel();
  });
}
