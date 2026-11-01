import { WebglAddon } from "@xterm/addon-webgl";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { ITerminalOptions, Terminal } from "@xterm/xterm";

import type { Settings } from "@/lib/api/types";
import {
  monoStack,
  prefersLightScheme,
  prefersReducedMotion,
  resolveMotion,
  resolveTheme,
} from "@/lib/prefs/appearance";
import { useSettings } from "@/store/settings";
import { COLOR_PREVIEW_EVENT } from "@/lib/prefs/colors";
import { terminalTheme } from "./terminalTheme";

/** Wait for glyph metrics before opening or resizing the terminal. */
export async function waitForFont(family: string, size: number): Promise<void> {
  if (!document.fonts) return;
  const name = family
    .split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!name) return;
  let timeout: number | undefined;
  try {
    await Promise.race([
      document.fonts.load(`${size}px "${name}"`),
      new Promise((resolve) => {
        timeout = window.setTimeout(resolve, 1500);
      }),
    ]);
  } catch {
    // A missing font still has a usable monospace fallback.
  } finally {
    window.clearTimeout(timeout);
  }
}

/** A font choice can change while its initial load is still pending. */
export async function waitForCurrentTerminalFont(cancelled: () => boolean): Promise<void> {
  while (!cancelled()) {
    const before = useSettings.getState().settings;
    await waitForFont(monoStack(before.monoFont), before.monoFontSize);
    const after = useSettings.getState().settings;
    if (before.monoFont === after.monoFont && before.monoFontSize === after.monoFontSize) return;
  }
}

export function terminalOptions(
  settings: Settings,
  light = prefersLightScheme(),
  reduced = prefersReducedMotion(),
): ITerminalOptions {
  const reduceMotion = resolveMotion(settings.motion, reduced) === "reduced";
  return {
    // The official Unicode addon uses xterm's proposed Unicode provider API.
    allowProposedApi: true,
    fontFamily: monoStack(settings.monoFont),
    fontSize: settings.monoFontSize,
    lineHeight: settings.terminalLineHeight,
    cursorStyle: settings.terminalCursorStyle,
    cursorBlink: settings.terminalCursorBlink,
    cursorInactiveStyle: settings.terminalInactiveCursorStyle,
    scrollback: settings.terminalScrollback,
    scrollSensitivity: settings.terminalScrollSensitivity,
    smoothScrollDuration: settings.terminalSmoothScrolling && !reduceMotion ? 100 : 0,
    scrollOnUserInput: settings.terminalScrollOnInput,
    theme: terminalTheme(resolveTheme(settings.theme, light), settings.colors),
  };
}

/** Shares live preferences and the official renderer lifecycle with the local preview. */
export function bindTerminalSettings(terminal: Terminal, fit: () => void) {
  // Configure widths before any output: Unicode 6 counts ❌ as one column and
  // splits emoji sequences, moving table borders and TUI cursor positions.
  terminal.loadAddon(new UnicodeGraphemesAddon());
  let disposed = false;
  let frame: number | null = null;
  let fontRevision = 0;
  let requestedFont = terminal.options.fontFamily;
  let requestedSize = terminal.options.fontSize;
  let rendererMode: Settings["terminalRenderer"] | null = null;
  let webgl: WebglAddon | null = null;
  let contextLoss: { dispose: () => void } | null = null;
  const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const requestLayout = () => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed) return;
      fit();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
  };
  const releaseRenderer = () => {
    contextLoss?.dispose();
    contextLoss = null;
    const addon = webgl;
    webgl = null;
    addon?.dispose();
  };
  const updateRenderer = (mode: Settings["terminalRenderer"]) => {
    // A failed/lost context is retried only after explicitly switching away and back.
    if (rendererMode === mode) return;
    rendererMode = mode;
    releaseRenderer();
    if (mode === "auto") {
      try {
        webgl = new WebglAddon();
        contextLoss = webgl.onContextLoss(() => {
          if (disposed || !webgl) return;
          releaseRenderer();
          requestLayout();
        });
        terminal.loadAddon(webgl);
      } catch {
        // The DOM renderer remains available on remote desktops and older GPUs.
        releaseRenderer();
      }
    }
    requestLayout();
  };
  const apply = () => {
    if (disposed) return;
    const settings = useSettings.getState().settings;
    const next = terminalOptions(settings, colorScheme.matches, motion.matches);
    const { fontFamily, fontSize, ...otherOptions } = next;
    const fontChanged = requestedFont !== fontFamily || requestedSize !== fontSize;
    const dimensionsChanged = terminal.options.lineHeight !== next.lineHeight;
    Object.assign(terminal.options, otherOptions);
    updateRenderer(settings.terminalRenderer);
    if (dimensionsChanged) requestLayout();
    if (fontChanged) {
      requestedFont = fontFamily;
      requestedSize = fontSize;
      const revision = ++fontRevision;
      void waitForFont(fontFamily!, fontSize!).then(() => {
        if (disposed || revision !== fontRevision) return;
        // Setting these only after loading lets xterm measure the real glyphs.
        terminal.options.fontFamily = fontFamily;
        terminal.options.fontSize = fontSize;
        requestLayout();
      });
    }
  };
  apply();
  const unsubscribe = useSettings.subscribe((state, previous) => {
    if (state.settings !== previous.settings) apply();
  });
  colorScheme.addEventListener("change", apply);
  motion.addEventListener("change", apply);
  window.addEventListener(COLOR_PREVIEW_EVENT, apply);
  return {
    requestLayout,
    dispose: () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      unsubscribe();
      colorScheme.removeEventListener("change", apply);
      motion.removeEventListener("change", apply);
      window.removeEventListener(COLOR_PREVIEW_EVENT, apply);
      releaseRenderer();
    },
  };
}
