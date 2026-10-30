// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Clock, FolderTree, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Misc";
import { resolveTheme, monoStack } from "@/lib/appearance";
import { decodeBase64, encodeBase64 } from "@/lib/base64";
import { consumeInput, type CommandCapture } from "@/lib/terminalInput";
import { api, events, isTauri } from "@/lib/ipc";
import { terminalTheme } from "@/features/terminal/terminalTheme";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";

interface TerminalPageProps {
  sessionId: string;
  active: boolean;
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

    const terminal = new Terminal({
      fontFamily: monoStack(monoFont),
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: terminalTheme(resolvedTheme),
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = addon;
    fit();
    terminal.focus();

    const subscriptions: UnlistenFn[] = [];
    const dataListener = terminal.onData((data) => {
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

    if (isTauri()) {
      void events
        .onSshData((payload) => {
          if (payload.sessionId === sessionId) {
            terminal.write(decodeBase64(payload.data));
          }
        })
        .then((unlisten) => subscriptions.push(unlisten));

      void events
        .onSshClosed((payload) => {
          if (payload.sessionId !== sessionId) {
            return;
          }
          setClosed(true);
          terminal.write(`\r\n\x1b[38;5;245m[${t("ssh.closed")}]\x1b[0m\r\n`);
        })
        .then((unlisten) => subscriptions.push(unlisten));
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(element);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      subscriptions.forEach((unlisten) => unlisten());
      dataListener.dispose();
      terminal.dispose();
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
