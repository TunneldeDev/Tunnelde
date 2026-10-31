// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Clock, FolderTree, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { StatusDot } from "@/components/ui/display/Misc";
import { resolveTheme, monoStack } from "@/lib/prefs/appearance";
import { decodeBase64, encodeBase64 } from "@/lib/text/base64";
import { consumeInput, type CommandCapture } from "@/lib/session/terminalInput";
import { api, events, isTauri } from "@/lib/api/ipc";
import { terminalTheme } from "@/features/terminal/terminalTheme";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";

interface TerminalPageProps {
  sessionId: string;
  active: boolean;
}

/** Waits for a webfont so xterm measures the real glyphs instead of the fallback. */
async function waitForFont(family: string, size: number): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) {
    return;
  }
  const name = family.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  if (!name) {
    return;
  }
  try {
    await Promise.race([
      document.fonts.load(`${size}px "${name}"`),
      new Promise((resolve) => window.setTimeout(resolve, 1500)),
    ]);
  } catch {
    // A missing webfont is not fatal; the fallback stack still renders.
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
  const resolvedTheme = resolveTheme(theme);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [closed, setClosed] = useState(false);
  const capture = useRef<CommandCapture>({ text: "", escape: 0 });

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
    if (isTauri()) {
      void api.sshResize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
    }
  }, [sessionId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let disposed = false;
    let terminal: Terminal | null = null;
    let addon: FitAddon | null = null;
    let dataListener: { dispose: () => void } | null = null;
    const subscriptions: UnlistenFn[] = [];
    const pending: Uint8Array[] = [];
    const write = (chunk: Uint8Array) => {
      if (terminal) {
        terminal.write(chunk);
      } else {
        pending.push(chunk);
      }
    };
    let frame = 0;
    let observer: ResizeObserver | null = null;

    const start = async () => {
      await waitForFont(monoStack(monoFont), fontSize);
      if (disposed) {
        return;
      }

      const instance = new Terminal({
        fontFamily: monoStack(monoFont),
        fontSize,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
        theme: terminalTheme(resolvedTheme),
      });
      terminal = instance;
      addon = new FitAddon();
      instance.loadAddon(addon);
      instance.open(element);
      terminalRef.current = instance;
      fitRef.current = addon;
      // Re-apply after open: a theme or font measured before the first frame
      // otherwise keeps the fallback colours and glyph metrics.
      instance.options.theme = terminalTheme(resolvedTheme);
      fit();
      instance.refresh(0, Math.max(0, instance.rows - 1));
      instance.focus();

      // Replay whatever arrived while the webfont was loading.
      for (const chunk of pending.splice(0)) {
        instance.write(chunk);
      }

      dataListener = instance.onData((data) => {
        if (!isTauri()) {
          return;
        }
        void api.sshWrite(sessionId, encodeBase64(data)).catch(() => undefined);

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
          if (payload.sessionId === sessionId) {
            write(decodeBase64(payload.data));
          }
        })
        .then((unlisten) => subscriptions.push(unlisten));

      void events
        .onSshClosed((payload) => {
          if (payload.sessionId !== sessionId) {
            return;
          }
          setClosed(true);
          write(new TextEncoder().encode(`\r\n\x1b[38;5;245m[${t("ssh.closed")}]\x1b[0m\r\n`));
        })
        .then((unlisten) => subscriptions.push(unlisten));
    }

    observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(element);

    // Late font swaps change glyph widths; re-measure once they settle.
    void document.fonts?.ready.then(() => {
      if (!disposed && terminal) {
        terminal.options.fontFamily = monoStack(monoFont);
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
        terminalRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [active, fit]);

  return (
    <div className="terminal-page">
      <header className="terminal-head">
        <StatusDot tone={closed ? "error" : "ok"} />
        <div className="terminal-head__text">
          <span className="terminal-head__title">{session?.title ?? t("nav.host")}</span>
          {session ? <span className="terminal-head__meta">{session.address}</span> : null}
        </div>
        <IconButton
          label={t("history.title")}
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
