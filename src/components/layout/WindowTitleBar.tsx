// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, GripVertical, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";

/** Compact window chrome replaces the OS title bar; it contains no app menu. */
export function WindowTitleBar() {
  const { t } = useTranslation();
  const style = useSettings((state) => state.settings.titleBarStyle);
  const os = useSettings((state) => state.info?.os);
  const [maximized, setMaximized] = useState(false);
  const enabled = isTauri() && style === "compact";
  const mac = os === "macos";

  useEffect(() => {
    if (!enabled || mac) return;
    const window = getCurrentWindow();
    let alive = true;
    let version = 0;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      const request = ++version;
      void window
        .isMaximized()
        .then((value) => {
          if (alive && request === version) setMaximized(value);
        })
        .catch(() => undefined);
    };
    refresh();
    void window
      .onResized(refresh)
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [enabled, mac]);

  const run = (action: () => Promise<unknown>) => {
    void action().catch((error) => toast(translateError(error), "error"));
  };
  const toggle = () =>
    run(async () => {
      const window = getCurrentWindow();
      await window.toggleMaximize();
      setMaximized(await window.isMaximized());
    });

  useEffect(() => {
    if (!enabled) return;
    const isDragTarget = (target: EventTarget | null) =>
      target instanceof Element && target.matches(".pane__tabs, .panel__head, .panel__title");
    const drag = (event: MouseEvent) => {
      if (event.button === 0 && event.detail < 2 && isDragTarget(event.target)) {
        void getCurrentWindow()
          .startDragging()
          .catch((error) => toast(translateError(error), "error"));
      }
    };
    const maximize = (event: MouseEvent) => {
      if (!isDragTarget(event.target)) return;
      const window = getCurrentWindow();
      void window
        .toggleMaximize()
        .then(() => window.isMaximized())
        .then(setMaximized)
        .catch((error) => toast(translateError(error), "error"));
    };
    document.addEventListener("mousedown", drag);
    document.addEventListener("dblclick", maximize);
    return () => {
      document.removeEventListener("mousedown", drag);
      document.removeEventListener("dblclick", maximize);
    };
  }, [enabled]);

  if (!enabled || mac) return null;

  return (
    <div className="window-titlebar" role="toolbar" aria-label={t("window.controls")}>
      <div
        className="window-titlebar__drag"
        title={t("window.drag")}
        onMouseDown={(event) => {
          if (event.button === 0 && event.detail < 2) run(() => getCurrentWindow().startDragging());
        }}
        onDoubleClick={toggle}
      >
        <GripVertical size={12} aria-hidden="true" />
      </div>
      <div className="window-titlebar__controls">
        <button
          type="button"
          aria-label={t("window.minimize")}
          title={t("window.minimize")}
          onClick={() => run(() => getCurrentWindow().minimize())}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          aria-label={t(maximized ? "window.restore" : "window.maximize")}
          title={t(maximized ? "window.restore" : "window.maximize")}
          onClick={toggle}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          type="button"
          className="is-close"
          aria-label={t("window.close")}
          title={t("window.close")}
          onClick={() => run(() => getCurrentWindow().close())}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
