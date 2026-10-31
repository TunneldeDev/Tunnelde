// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { useEffect } from "react";

import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";
import { isTauri } from "@/lib/api/ipc";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";

/** Protect drafts on native X/Alt+F4 as well as the compact close button. */
export function useWindowCloseGuard(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let alive = true;
    let closing = false;
    let unlisten: UnlistenFn | undefined;

    const keepsWindow = () => {
      const state = useSettings.getState();
      return state.info?.os === "macos" || state.settings.closeToTray;
    };

    const subscribe = async () => {
      const stop = await window.onCloseRequested(onCloseRequested);
      if (alive) unlisten = stop;
      else await stop();
    };

    const closeWindow = async () => {
      if (!alive || closing) return;
      closing = true;
      try {
        // Preferences may have changed while the confirmation was open.
        if (!keepsWindow()) {
          const stop = unlisten;
          unlisten = undefined;
          // Tauri's unlisten returns a Promise at runtime. Wait for the native
          // listener to disappear before close, avoiding a second close prompt.
          await stop?.();
        }
        await window.close();
      } catch (error) {
        // Keep the draft in memory until the window really exits, so even a
        // failed native close cannot turn an approved discard into data loss.
        if (alive && !unlisten) {
          try {
            await subscribe();
          } catch (listenError) {
            toast(translateError(listenError), "error");
          }
        }
        if (alive) toast(translateError(error), "error");
      } finally {
        closing = false;
      }
    };

    function onCloseRequested(event: CloseRequestedEvent) {
      // Tauri otherwise calls destroy(), bypassing the Rust tray/macOS policy.
      event.preventDefault();
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

    void subscribe().catch((error) => {
      if (alive) toast(translateError(error), "error");
    });
    return () => {
      alive = false;
      void unlisten?.();
    };
  }, []);
}
