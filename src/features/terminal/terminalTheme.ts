// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { ITheme } from "@xterm/xterm";

import type { ResolvedTheme } from "@/lib/appearance";

const DARK: ITheme = {
  background: "#070b12",
  foreground: "#e6edf7",
  cursor: "#35e0ff",
  cursorAccent: "#070b12",
  selectionBackground: "rgba(47, 111, 237, 0.35)",
  black: "#0e1420",
  red: "#ff5d6c",
  green: "#3ddc97",
  yellow: "#f2b84b",
  blue: "#2f6fed",
  magenta: "#8b7cf6",
  cyan: "#35e0ff",
  white: "#e6edf7",
  brightBlack: "#5b6880",
  brightRed: "#ff7d89",
  brightGreen: "#5ce8ac",
  brightYellow: "#ffcf70",
  brightBlue: "#5a90ff",
  brightMagenta: "#a99cff",
  brightCyan: "#6ceaff",
  brightWhite: "#ffffff",
};

const LIGHT: ITheme = {
  background: "#f8fafd",
  foreground: "#131a28",
  cursor: "#2563eb",
  cursorAccent: "#f8fafd",
  selectionBackground: "rgba(37, 99, 235, 0.2)",
  black: "#131a28",
  red: "#c92a3a",
  green: "#1f8f5f",
  yellow: "#a67211",
  blue: "#2563eb",
  magenta: "#6d5bd0",
  cyan: "#0f7f96",
  white: "#d9dee8",
  brightBlack: "#7b8798",
  brightRed: "#e04455",
  brightGreen: "#22a86f",
  brightYellow: "#bf8615",
  brightBlue: "#2f6fed",
  brightMagenta: "#7b6bf0",
  brightCyan: "#128da6",
  brightWhite: "#ffffff",
};

export function terminalTheme(theme: ResolvedTheme): ITheme {
  return theme === "light" ? LIGHT : DARK;
}
