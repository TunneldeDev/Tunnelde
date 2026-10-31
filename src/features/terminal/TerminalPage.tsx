// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Clock, FolderTree, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { StatusDot } from "@/components/ui/display/Misc";
import { resolveTheme, monoStack, prefersLightScheme } from "@/lib/prefs/appearance";
import { MONO_FONT_OPTIONS } from "@/lib/prefs/defaults";
import type { MonoFont } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { decodeBase64, encodeBase64 } from "@/lib/text/base64";
import { consumeInput, type CommandCapture } from "@/lib/session/terminalInput";
import { api, events, isTauri } from "@/lib/api/ipc";
import { terminalTheme } from "@/features/terminal/terminalTheme";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";

interface TerminalPageProps {
  sessionId: string;
  active: boolean;
}

/** Waits for a webfont so xterm measures the real glyphs instead of the fallback. */
async function waitForFont(family: string, size: number): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) {
    return;
  }
  const name = family
    .split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!name) {
    return;
  }
  let timeout: number | undefined;
  try {
    await Promise.race([
      document.fonts.load(`${size}px "${name}"`),
      new Promise((resolve) => {
        timeout = window.setTimeout(resolve, 1500);
      }),
    ]);
  } catch {
    // A missing webfont is not fatal; the fallback stack still renders.
  } finally {
    window.clearTimeout(timeout);
  }
}

export function TerminalPage({ sessionId, active }: TerminalPageProps) {
  const { t } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const disconnect = useSsh((state) => state.disconnect);
  const openSftp = useWorkspace((state) => state.openSftp);
  const openHistory = useWorkspace((state) => state.openHistory);
  const theme = useSettings((state) => state.settings.theme);
  const fontSize = useSettings((state) => state.settings.monoFontSize);
  const monoFont = useSettings((state) => state.settings.monoFont);
  const recordTerminalHistory = useSettings((state) => state.settings.recordTerminalHistory);
  const updateSettings = useSettings((state) => state.update);
  const disconnecting = useSsh((state) => state.disconnectingSessionIds.includes(sessionId));
  const [prefersLight, setPrefersLight] = useState(prefersLightScheme);
  const resolvedTheme = resolveTheme(theme, prefersLight);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const change = () => setPrefersLight(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [closed, setClosed] = useState(false);
  const capture = useRef<CommandCapture>({ text: "", escape: 0 });
  useEffect(() => {
    capture.current = { text: "", escape: 0 };
  }, [recordTerminalHistory]);
  const lastSize = useRef({ sessionId: "", cols: 0, rows: 0 });
  const focus = useCallback(() => {
    if (!activeRef.current || useDialogs.getState().dialog.kind !== "none") {
      return;
    }
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused.closest("input, select, button, [role='listbox']")
    ) {
      return;
    }
    terminalRef.current?.focus();
  }, []);

  const fit = useCallback(() => {
    const terminal = terminalRef.current;
    const addon = fitRef.current;
    const element = containerRef.current;
    if (!terminal || !addon || !element || element.clientWidth < 24 || element.clientHeight < 24) {
      return;
    }
    try {
      addon.fit();
    } catch {
      return;
    }
    const previous = lastSize.current;
    if (
      isTauri() &&
      (previous.sessionId !== sessionId ||
        previous.cols !== terminal.cols ||
        previous.rows !== terminal.rows)
    ) {
      lastSize.current = { sessionId, cols: terminal.cols, rows: terminal.rows };
      void api.sshResize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
    }
  }, [sessionId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let disposed = false;
    let ended = false;
    let terminal: Terminal | null = null;
    let addon: FitAddon | null = null;
    let dataListener: { dispose: () => void } | null = null;
    const subscriptions: UnlistenFn[] = [];
    const pending: Uint8Array[] = [];
    const write = (chunk: Uint8Array) => {
      if (disposed) {
        return;
      }
      if (terminal) {
        terminal.write(chunk);
      } else {
        pending.push(chunk);
      }
    };
    let frame = 0;
    let observer: ResizeObserver | null = null;

    const start = async () => {
      const initial = useSettings.getState().settings;
      await waitForFont(monoStack(initial.monoFont), initial.monoFontSize);
      if (disposed) {
        return;
      }

      // Preferences may change while the first font is still loading.
      const settings = useSettings.getState().settings;
      const currentTheme = resolveTheme(settings.theme, prefersLightScheme());

      const instance = new Terminal({
        fontFamily: monoStack(settings.monoFont),
        fontSize: settings.monoFontSize,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: "block",
        // Keep the cursor visible when the terminal does not hold focus.
        cursorInactiveStyle: "block",
        scrollback: 5000,
        allowProposedApi: false,
        theme: terminalTheme(currentTheme),
      });
      terminal = instance;
      addon = new FitAddon();
      instance.loadAddon(addon);
      instance.open(element);
      terminalRef.current = instance;
      fitRef.current = addon;
      // Re-apply after open: a theme or font measured before the first frame
      // otherwise keeps the fallback colours and glyph metrics.
      instance.options.theme = terminalTheme(currentTheme);
      fit();
      instance.refresh(0, Math.max(0, instance.rows - 1));
      focus();

      // Replay whatever arrived while the webfont was loading.
      for (const chunk of pending.splice(0)) {
        instance.write(chunk);
      }

      dataListener = instance.onData((data) => {
        if (!isTauri() || disposed || ended) {
          return;
        }
        void api.sshWrite(sessionId, encodeBase64(data)).catch(() => undefined);

        // Raw terminal input includes password prompts and program responses.
        // Capturing it requires an explicit user opt-in, separate from SSH I/O.
        if (!useSettings.getState().settings.recordTerminalHistory) {
          capture.current = { text: "", escape: 0 };
          return;
        }
        const result = consumeInput(capture.current, data);
        capture.current = result.state;
        for (const command of result.commands) {
          if (command.startsWith(" ")) {
            continue;
          }
          const hostId = useSsh.getState().sessions.find((item) => item.id === sessionId)?.hostId;
          if (hostId) {
            void api.historyRecord(hostId, command).catch(() => undefined);
          }
        }
      });
    };

    // Listen before the terminal exists so early output is buffered, not lost.
    if (isTauri()) {
      void events
        .onSshData((payload) => {
          if (!disposed && payload.sessionId === sessionId) {
            write(decodeBase64(payload.data));
          }
        })
        .then((unlisten) => (disposed ? unlisten() : subscriptions.push(unlisten)))
        .catch((error: unknown) => !disposed && toast(translateError(error), "error"));

      void events
        .onSshClosed((payload) => {
          if (disposed || payload.sessionId !== sessionId) {
            return;
          }
          ended = true;
          setClosed(true);
          write(new TextEncoder().encode(`\r\n\x1b[38;5;245m[${t("ssh.closed")}]\x1b[0m\r\n`));
        })
        .then((unlisten) => (disposed ? unlisten() : subscriptions.push(unlisten)))
        .catch((error: unknown) => !disposed && toast(translateError(error), "error"));
    }

    observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(element);

    // Late font swaps change glyph widths; re-measure once they settle.
    void document.fonts?.ready.then(() => {
      if (!disposed && terminal) {
        terminal.options.fontFamily = monoStack(useSettings.getState().settings.monoFont);
        fit();
      }
    });

    void start();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      subscriptions.forEach((unlisten) => unlisten());
      dataListener?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      pending.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.theme = terminalTheme(resolvedTheme);
    }
  }, [resolvedTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.fontSize = fontSize;
      fit();
    }
  }, [fontSize, fit]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.fontFamily = monoStack(monoFont);
      fit();
    }
  }, [monoFont, fit]);

  useEffect(() => {
    if (active) {
      const frame = requestAnimationFrame(() => {
        fit();
        focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [active, fit, focus]);

  return (
    <div className="terminal-page">
      <header className="terminal-head">
        <StatusDot tone={closed ? "error" : "ok"} />
        <div className="terminal-head__text">
          <span className="terminal-head__title">{session?.title ?? t("nav.host")}</span>
          {session ? <span className="terminal-head__meta">{session.address}</span> : null}
        </div>
        <Select
          label={t("settings.monoFont")}
          className="terminal-font-select"
          value={monoFont}
          options={MONO_FONT_OPTIONS}
          onChange={(value) => void updateSettings({ monoFont: value as MonoFont })}
        />
        <IconButton
          label={t("history.title")}
          disabled={!session || closed}
          onClick={() => {
            if (session) {
              openHistory(session);
            }
          }}
        >
          <Clock size={15} />
        </IconButton>
        <IconButton
          label={t("sftp.title")}
          disabled={!session || closed}
          onClick={() => {
            if (session) {
              openSftp(session);
            }
          }}
        >
          <FolderTree size={15} />
        </IconButton>
        <IconButton
          label={t("terminal.disconnect")}
          disabled={!session || closed || disconnecting}
          onClick={() => {
            void disconnect(sessionId);
          }}
        >
          <X size={15} />
        </IconButton>
      </header>
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}
