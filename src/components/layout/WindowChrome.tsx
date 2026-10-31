// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Maximize2, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useTranslation } from "react-i18next";

import { isTauri } from "@/lib/api/ipc";

/** Mirrors the direction strings the window API accepts. */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const EDGES: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "is-north" },
  { direction: "South", className: "is-south" },
  { direction: "West", className: "is-west" },
  { direction: "East", className: "is-east" },
  { direction: "NorthWest", className: "is-north-west" },
  { direction: "NorthEast", className: "is-north-east" },
  { direction: "SouthWest", className: "is-south-west" },
  { direction: "SouthEast", className: "is-south-east" },
];

/**
 * Window buttons and edge grips for the frameless mode. The native frame draws
 * these itself, so this only renders when the in-app title bar is enabled.
 */
export function WindowChrome() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const win = getCurrentWindow();
    let alive = true;
    void win.isMaximized().then((value) => alive && setMaximized(value));
    const unlisten = win.onResized(() => {
      void win.isMaximized().then((value) => alive && setMaximized(value));
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  if (!isTauri()) {
    return null;
  }

  const win = getCurrentWindow();

  return (
    <>
      <div className="window-controls">
        <button
          type="button"
          className="window-controls__button"
          aria-label={t("window.minimize")}
          onClick={() => void win.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className="window-controls__button"
          aria-label={maximized ? t("window.restore") : t("window.maximize")}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? <Square size={11} /> : <Maximize2 size={11} />}
        </button>
        <button
          type="button"
          className="window-controls__button is-close"
          aria-label={t("window.close")}
          onClick={() => void win.close()}
        >
          <X size={14} />
        </button>
      </div>

      {EDGES.map((edge) => (
        <div
          key={edge.direction}
          className={`window-grip ${edge.className}`}
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            void win.startResizeDragging(edge.direction);
          }}
        />
      ))}
    </>
  );
}
