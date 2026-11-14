import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";
import { isTauri } from "@/lib/api/ipc";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { beforeWindowReload } from "./reload";

/** Native ownership is replaced when a document navigates. Ordinary event
 * listeners cannot retain a Tauri close veto after their JavaScript is gone. */
export function useWindowCloseGuard(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const owner = crypto.randomUUID();
    let alive = true;
    let closing = false;
    let unlisten: (() => Promise<void>) | undefined;

    const keepsWindow = () => {
      const state = useSettings.getState();
      return state.info?.os === "macos" || state.settings.closeToTray;
    };

    const closeWindow = async () => {
      if (!alive || closing) return;
      closing = true;
      try {
        await invoke("main_window_close_guard_finish", { owner });
      } catch (error) {
        // A failed close retains both the guard and the user's in-memory draft.
        if (alive) toast(translateError(error), "error");
      } finally {
        closing = false;
      }
    };

    function onCloseRequested() {
      if (!alive || closing || keepsWindow()) return;
      const editors = useEditors.getState();
      const dirty = Object.values(editors.entries).filter((entry) => editors.isDirty(entry.tabId));
      if (!dirty.length) {
        void closeWindow();
        return;
      }
      const dialog = useDialogs.getState().dialog;
      if (dialog.kind === "confirm" && dialog.onConfirm === closeWindow) return;
      useDialogs.getState().confirm({
        title: i18n.t("window.unsavedTitle"),
        body: i18n.t("window.unsavedBody", { names: dirty.map((entry) => entry.name).join(", ") }),
        confirmLabel: i18n.t("window.discardAndClose"),
        danger: true,
        onConfirm: closeWindow,
      });
    }

    const subscription = (async () => {
      const stop = await listen<string>("ui://close-requested", ({ payload }) => {
        if (payload === owner) onCloseRequested();
      });
      const release = async () => {
        await invoke("main_window_close_guard_release", { owner });
        await stop();
      };
      try {
        await invoke("main_window_close_guard_claim", { owner });
      } catch (error) {
        await stop();
        throw error;
      }
      if (alive) unlisten = release;
      else await release();
    })();
    const removeReloadPreparation = beforeWindowReload(async () => {
      await subscription;
      await unlisten?.();
      unlisten = undefined;
    });
    void subscription.catch((error) => {
      if (alive) toast(translateError(error), "error");
    });
    return () => {
      alive = false;
      removeReloadPreparation();
      void unlisten?.().catch(() => undefined);
    };
  }, []);
}
