import i18n from "@/i18n/i18n";
import { useDialogs, type DialogState } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import type { PanelWindowClient } from "./windowClient";

export type NativePluginUiPrompt = { id: string; pluginId: string; message: string } & (
  { method: "ui.confirm" } | { method: "ui.showMessage"; kind: "info" | "success" | "error" }
);
type UiClient = Pick<PanelWindowClient, "listPluginUi" | "replyPluginUi" | "subscribe">;

/** One UI host per native document, shared by all its view children. No main
 * resource bootstrap, plugin activation store or raw document credentials. */
export function startNativePluginUi(client: UiClient, failure: (error: unknown) => void) {
  let disposed = false,
    running = false,
    queued = false;
  let unlisten: (() => void) | undefined;
  let active: { id: string; dialog: DialogState; stop: () => void } | undefined;
  const seen = new Set<string>();
  const replying = new Set<string>();
  const reply = async (id: string, value: boolean | null, error?: string) => {
    if (replying.has(id)) return;
    replying.add(id);
    try {
      await client.replyPluginUi(id, value, error);
    } catch (cause) {
      // Native denies expired/revoked consent; never retry it or approve through
      // a different window. This is diagnostic, not an unsolicited error toast.
      if (!disposed) failure(cause);
    } finally {
      replying.delete(id);
    }
  };
  const dismiss = () => {
    const current = active;
    active = undefined;
    current?.stop();
    if (current && useDialogs.getState().dialog === current.dialog) useDialogs.getState().close();
  };
  const confirm = (prompt: NativePluginUiPrompt) => {
    if (useDialogs.getState().dialog.kind !== "none") {
      void reply(prompt.id, false, "dialog.busy");
      return;
    }
    const settle = async (value: boolean) => {
      if (active?.id !== prompt.id) return;
      dismiss();
      await reply(prompt.id, value);
    };
    useDialogs.getState().confirm({
      title: i18n.t("pluginApi.confirmTitle", { name: prompt.pluginId }),
      body: prompt.message,
      preformatted: true,
      confirmLabel: i18n.t("pluginApi.confirm"),
      onConfirm: () => settle(true),
    });
    const dialog = useDialogs.getState().dialog;
    active = {
      id: prompt.id,
      dialog,
      stop: useDialogs.subscribe((state) => {
        if (state.dialog !== dialog) void settle(false);
      }),
    };
  };
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          const prompts = await client.listPluginUi();
          if (disposed) return;
          const ids = new Set(prompts.map((p) => p.id));
          if (active && !ids.has(active.id)) dismiss();
          for (const id of seen) if (!ids.has(id) && !replying.has(id)) seen.delete(id);
          for (const prompt of prompts) {
            if (seen.has(prompt.id)) continue;
            seen.add(prompt.id);
            if (prompt.method === "ui.confirm") confirm(prompt);
            else {
              toast(
                `${i18n.t("pluginApi.messageTitle", { name: prompt.pluginId })}: ${prompt.message}`,
                prompt.kind,
              );
              void reply(prompt.id, null);
            }
          }
        }
      } catch (error) {
        // Loss of authority is not permission to leave an old consent visible.
        dismiss();
        if (!disposed) failure(error);
      } finally {
        running = false;
      }
    })();
  };
  // Invalidation is an optimization. Polling also dismisses expired prompts if
  // a WebView misses an event while native revocation/reload cleanup happens.
  const timer = window.setInterval(refresh, 1000);
  void client
    .subscribe(refresh)
    .then((stop) => {
      if (disposed) stop();
      else {
        unlisten = stop;
        refresh();
      }
    })
    .catch((error) => {
      if (!disposed) failure(error);
    });
  refresh();
  return () => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(timer);
    unlisten?.();
    const id = active?.id;
    dismiss();
    if (id) void reply(id, false);
    seen.clear();
  };
}
