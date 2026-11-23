import type { TerminalViewServices } from "./terminalViewServices";
import {
  bindShortcutProvider,
  consumeShortcutRelease,
  dispatchShortcuts,
  executeShortcutCandidates,
  scopedShortcutCandidates,
} from "@/lib/keyboard/routing";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Clock, FolderTree, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { StatusDot } from "@/components/ui/display/Misc";
import { MONO_FONT_OPTIONS } from "@/lib/prefs/defaults";
import type { MonoFont } from "@/lib/api/types";
import { presentError } from "@/lib/api/errors";
import { decodeBase64, encodeBase64 } from "@/lib/text/base64";
import { consumeInput, type CommandCapture } from "@/lib/session/terminalInput";
import { copyText } from "@/lib/session/clipboard";
import { recordTerminalCommand } from "@/lib/session/history";
import { api, events, isTauri } from "@/lib/api/ipc";
import {
  bindTerminalSettings,
  localTerminalSettings,
  terminalOptions,
  waitForCurrentTerminalFont,
} from "./terminalRuntime";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";
import { useContextMenu } from "@/store/contextMenu";
import { toast } from "@/store/toasts";
import { createTerminalOutputDecoder } from "./terminalOutput";
import { bindTerminalClipboard } from "./terminalClipboard";
import { terminalSequenceFor } from "./terminalKeyboard";
import { registerTerminalCheckpoint, takeTerminalCheckpoint } from "./terminalCheckpoint";
import {
  captureTerminalState,
  restoreTerminalState,
  terminalUsesEnhancedKeyboard,
} from "./terminalState";
import { shortcutMatches } from "@/lib/keyboard/registry";
import { createTerminalBridge, type TerminalBridge } from "@/lib/extensions/terminal/bridge";
import { reportError } from "@/lib/diagnostics";
import { TerminalSurface } from "./TerminalSurface";

interface TerminalPageProps {
  sessionId: string;
  active: boolean;
}

export function TerminalPage({ sessionId, active }: TerminalPageProps) {
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const disconnecting = useSsh((state) => state.disconnectingSessionIds.includes(sessionId));
  return (
    <TerminalPageView
      sessionId={sessionId}
      active={active}
      services={{
        native: isTauri(),
        session,
        disconnecting,
        settings: localTerminalSettings,
        io: api,
        events,
        disconnect: (id) => useSsh.getState().disconnect(id),
        openSftp: (session) => {
          useWorkspace.getState().openSftp(session);
        },
        openHistory: (session) => {
          useWorkspace.getState().openHistory(session);
        },
        updateFont: (monoFont) => useSettings.getState().update({ monoFont }),
        recordCommand: recordTerminalCommand,
        copy: copyText,
        dialogOpen: () => useDialogs.getState().dialog.kind !== "none",
        releaseOnFailure: true,
        checkpoints: { take: takeTerminalCheckpoint, register: registerTerminalCheckpoint },
      }}
    />
  );
}

/** Shared production renderer. A satellite supplies read-only data and scoped
 * services here; it never starts writable stores, SSH bootstrap or autoconnect. */
export function TerminalPageView({
  sessionId,
  active,
  services,
}: TerminalPageProps & { services: TerminalViewServices }) {
  const { t } = useTranslation();
  const serviceRef = useRef(services);
  useEffect(() => {
    serviceRef.current = services;
  }, [services]);
  const session = services.session;
  const disconnecting = services.disconnecting;
  const preferences = useSyncExternalStore(services.settings.subscribe, services.settings.read);
  const monoFont = preferences.monoFont;
  const recordTerminalHistory = preferences.recordTerminalHistory;
  const Surface = services.Surface ?? TerminalSurface;
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const clipboardRef = useRef<{
    copy: () => void;
    copyAndClear: () => void;
    paste: () => void;
    selectAll: () => void;
    hasSelection: () => boolean;
    canPaste: () => boolean;
  } | null>(null);
  const [closed, setClosed] = useState(false);
  const [bridge, setBridge] = useState<TerminalBridge | null>(null);
  useEffect(() => {
    bridge?.update({ hostId: session?.hostId ?? null, title: session?.title ?? "" });
  }, [bridge, session?.hostId, session?.title]);
  const capture = useRef<CommandCapture>({ text: "", escape: 0 });
  useEffect(() => {
    capture.current = { text: "", escape: 0 };
  }, [recordTerminalHistory]);
  const lastSize = useRef({ sessionId: "", cols: 0, rows: 0 });
  const checkpointing = useRef(false);
  const resizeRevision = useRef(0);
  const focus = useCallback(() => {
    if (
      !activeRef.current ||
      document.querySelector("[role='dialog']") ||
      serviceRef.current.dialogOpen()
    ) {
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
    if (checkpointing.current) return;
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
      serviceRef.current.native &&
      (previous.sessionId !== sessionId ||
        previous.cols !== terminal.cols ||
        previous.rows !== terminal.rows)
    ) {
      const next = { sessionId, cols: terminal.cols, rows: terminal.rows };
      const revision = ++resizeRevision.current;
      void serviceRef.current.io
        .sshResize(sessionId, next.cols, next.rows)
        .then(() => {
          // Staged resize is intentionally rejected. Do not cache it as applied:
          // the committed destination must send its real geometry on activation.
          if (revision === resizeRevision.current && terminalRef.current === terminal)
            lastSize.current = next;
        })
        .catch(() => undefined);
    }
  }, [sessionId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let unregisterShortcuts: (() => void) | undefined;
    const terminalBridge = createTerminalBridge(sessionId, (error) =>
      reportError("plugins.frontend", "terminal.subscription", error),
    );
    setBridge(terminalBridge);
    let detachBridge: (() => void) | undefined;
    let disposed = false;
    let ended = serviceRef.current.closed ?? false;
    let registrationFailed = false;
    setClosed(ended);
    if (ended) terminalBridge.update({ status: "closed" });
    let terminal: Terminal | null = null;
    let addon: FitAddon | null = null;
    let runtime: ReturnType<typeof bindTerminalSettings> | null = null;
    let dataListener: { dispose: () => void } | null = null;
    let selectionListener: { dispose: () => void } | null = null;
    let applicationClipboard: { dispose: () => void } | null = null;
    let selectionTimer: number | undefined;
    let copiedSelection = "";
    const subscriptions: UnlistenFn[] = [];
    const pending: string[] = [];
    let decodeOutput = createTerminalOutputDecoder();
    let sequence = 0;
    let unregisterCheckpoint: (() => void) | undefined;
    const sequenceWaiters = new Set<() => void>();
    const waitForSequence = (target: number) =>
      new Promise<void>((resolve, reject) => {
        if (sequence >= target) return resolve();
        const timer = window.setTimeout(() => {
          sequenceWaiters.delete(check);
          reject(new Error("terminal.checkpointBusy"));
        }, 2000);
        const check = () => {
          if (sequence < target && !disposed && !ended) return;
          window.clearTimeout(timer);
          sequenceWaiters.delete(check);
          if (disposed) reject(new Error("terminal.checkpointBusy"));
          else resolve();
        };
        sequenceWaiters.add(check);
      });
    const write = (chunk: Uint8Array) => {
      if (disposed) {
        return;
      }
      // Native streaming decode also avoids xterm's partial UTF-8 continuation
      // bug, which can drop a ZWJ when a packet ends in a 0x80 byte.
      const text = decodeOutput(chunk);
      if (!text) return;
      if (terminal) {
        terminal.write(text);
      } else {
        pending.push(text);
      }
    };
    let observer: ResizeObserver | null = null;

    const start = async () => {
      await waitForCurrentTerminalFont(() => disposed, serviceRef.current.settings);
      if (disposed) {
        return;
      }

      // Preferences may change while the first font is still loading.
      const settings = serviceRef.current.settings.read();
      const checkpoint = serviceRef.current.checkpoints.take(sessionId);
      if (checkpoint) {
        checkpointing.current = true;
        sequence = checkpoint.sequence;
        decodeOutput = createTerminalOutputDecoder(checkpoint.decoder);
        capture.current = checkpoint.input;
      }
      const instance = new Terminal({
        ...terminalOptions(settings),
        ...(checkpoint ? { cols: checkpoint.cols, rows: checkpoint.rows } : {}),
      });
      terminal = instance;
      addon = new FitAddon();
      instance.loadAddon(addon);
      instance.open(element);
      terminalRef.current = instance;
      fitRef.current = addon;
      runtime = bindTerminalSettings(instance, fit, { source: serviceRef.current.settings });
      const serializer = new SerializeAddon();
      instance.loadAddon(serializer);
      if (checkpoint) {
        await new Promise<void>((resolve) => instance.write(checkpoint.data, resolve));
        if (disposed) return;
        restoreTerminalState(instance, checkpoint.state);
        if (checkpoint.decoder.control) {
          await new Promise<void>((resolve) => instance.write(checkpoint.decoder.control, resolve));
          if (disposed) return;
        }
        instance.scrollToLine(checkpoint.viewportY);
        checkpointing.current = false;
      }
      unregisterCheckpoint = serviceRef.current.checkpoints.register(sessionId, {
        prepare: async () => {
          checkpointing.current = true;
          terminalBridge.update({ status: "suspended" });
          const barrier = ended ? sequence : await serviceRef.current.io.sshDetach(sessionId);
          await waitForSequence(barrier);
          // write callbacks run after xterm has parsed every preceding packet.
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(
              () => reject(new Error("terminal.checkpointBusy")),
              2000,
            );
            instance.write("", () => {
              window.clearTimeout(timer);
              resolve();
            });
          });
          if (disposed) throw new Error("terminal.checkpointBusy");
          return {
            sequence,
            cols: instance.cols,
            rows: instance.rows,
            viewportY: instance.buffer.active.viewportY,
            data: serializer.serialize(),
            decoder: decodeOutput.checkpoint(),
            state: captureTerminalState(instance),
            input: { ...capture.current },
          };
        },
        resume: async () => {
          if (disposed) return;
          // Keep input/resize frozen until stream reattachment succeeds. A
          // failed rollback must not let users type blindly into a detached PTY.
          if (!ended) await serviceRef.current.io.sshAttach(sessionId);
          if (disposed) return;
          checkpointing.current = false;
          terminalBridge.update({ status: ended ? "closed" : "ready" });
          runtime?.requestLayout();
        },
      });
      const writeClipboard = (text: string) =>
        serviceRef.current.native
          ? serviceRef.current.io.clipboardWriteText(text)
          : navigator.clipboard.writeText(text);
      applicationClipboard = bindTerminalClipboard(
        instance,
        element,
        () =>
          !ended &&
          activeRef.current &&
          serviceRef.current.settings.read().terminalApplicationClipboard,
        writeClipboard,
        () => toast(t("menu.copyFailed"), "error"),
      );
      const copy = () => {
        if (!disposed && instance.hasSelection()) {
          serviceRef.current.copy(instance.getSelection());
          instance.focus();
        }
      };
      const paste = () => {
        if (disposed || ended) {
          return;
        }
        void (
          serviceRef.current.native
            ? serviceRef.current.io.clipboardReadText()
            : navigator.clipboard.readText()
        ).then(
          (text) => {
            if (!disposed && !ended) {
              // xterm preserves bracketed-paste mode and normalizes newlines.
              instance.paste(text);
              instance.focus();
            }
          },
          () => !disposed && toast(t("terminal.pasteFailed"), "error"),
        );
      };
      clipboardRef.current = {
        copy,
        copyAndClear: () => {
          copy();
          if (!disposed) instance.clearSelection();
        },
        paste,
        selectAll: () => {
          if (!disposed) {
            instance.selectAll();
            instance.focus();
          }
        },
        hasSelection: () => !disposed && instance.hasSelection(),
        canPaste: () => !disposed && !ended,
      };
      selectionListener = instance.onSelectionChange(() => {
        // A TUI redraw may clear the selection immediately after mouse release.
        // Keep the text captured at selection time, rather than reading it after the delay.
        const text = instance.getSelection();
        if (!text) {
          copiedSelection = "";
          return;
        }
        window.clearTimeout(selectionTimer);
        if (!serviceRef.current.settings.read().terminalCopyOnSelect) return;
        selectionTimer = window.setTimeout(() => {
          if (disposed || !serviceRef.current.settings.read().terminalCopyOnSelect) return;
          if (text === copiedSelection) return;
          copiedSelection = text;
          // Selection changes must not steal focus or flood success notifications.
          void writeClipboard(text).catch(() => {
            if (disposed) return;
            if (copiedSelection === text) copiedSelection = "";
            toast(t("menu.copyFailed"), "error");
          });
        }, 150);
      });
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const terminalCandidates = (event: KeyboardEvent) =>
        scopedShortcutCandidates(
          event,
          [
            "terminal.selectAll",
            "terminal.paste",
            "terminal.copy",
            "terminal.lineStart",
            "terminal.lineEnd",
            "terminal.wordLeft",
            "terminal.wordRight",
            "terminal.deleteLineStart",
            "terminal.deleteLineEnd",
          ],
          (id) => {
            if (disposed) return false;
            if (id === "terminal.selectAll") {
              instance.selectAll();
              return true;
            }
            if (id === "terminal.copy") {
              const plainControlC =
                event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey &&
                event.key.toLowerCase() === "c";
              if (
                (plainControlC && !mac && !instance.hasSelection()) ||
                (!instance.hasSelection() && instance.modes.mouseTrackingMode !== "none")
              )
                return false;
              copy();
              return true;
            }
            if (ended || checkpointing.current) return false;
            if (id === "terminal.paste") {
              paste();
              return true;
            }
            const settings = serviceRef.current.settings.read();
            const customized =
              Object.hasOwn(settings.keyboardShortcuts, id) ||
              Object.keys(settings.shortcutRules?.[id] ?? {}).some((binding) =>
                shortcutMatches(event, binding),
              );
            const sequence = terminalSequenceFor(
              id,
              terminalUsesEnhancedKeyboard(instance),
              customized,
            );
            if (sequence === null) return false;
            instance.input(sequence, true);
            return true;
          },
          serviceRef.current.isolatedShortcuts
            ? serviceRef.current.settings.read().keyboardShortcuts
            : undefined,
        );
      const routed = new WeakMap<KeyboardEvent, ReturnType<typeof executeShortcutCandidates>>();
      const routeScoped = (event: KeyboardEvent) => {
        const previous = routed.get(event);
        if (previous) return previous;
        const result =
          event.defaultPrevented ||
          event.isComposing ||
          event.keyCode === 229 ||
          serviceRef.current.dialogOpen()
            ? { handled: false, consumed: false }
            : executeShortcutCandidates(
                event,
                terminalCandidates(event),
                serviceRef.current.settings.read().shortcutRules,
              );
        routed.set(event, result);
        return result;
      };
      unregisterShortcuts = bindShortcutProvider(
        element,
        terminalCandidates,
        serviceRef.current.isolatedShortcuts ? routeScoped : undefined,
      );
      const imeEnterPresses = new Set<string>();
      instance.attachCustomKeyEventHandler((event) => {
        if (disposed || ended || checkpointing.current || event.defaultPrevented) return false;
        if (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter") {
          const key = event.code || event.key;
          if (event.type === "keydown") {
            if (event.keyCode === 229) {
              imeEnterPresses.add(key);
              // Keep xterm's composition/direct-commit handling for this down.
              return true;
            }
            if (!event.repeat) imeEnterPresses.delete(key);
          }
          if (imeEnterPresses.has(key)) {
            if (event.type === "keyup") imeEnterPresses.delete(key);
            // WebKit can release an IME Enter as keyCode 13 after its 229 down.
            return false;
          }
        }
        if (consumeShortcutRelease(event)) {
          event.preventDefault();
          return false;
        }
        if (
          event.type !== "keydown" ||
          event.isComposing ||
          event.keyCode === 229 ||
          event.getModifierState("AltGraph")
        )
          return true;
        const result = serviceRef.current.isolatedShortcuts
          ? routeScoped(event)
          : event.target instanceof Element
            ? dispatchShortcuts(event)
            : executeShortcutCandidates(
                event,
                terminalCandidates(event),
                serviceRef.current.settings.read().shortcutRules,
              );
        return !result.consumed;
      });
      fit();
      instance.refresh(0, Math.max(0, instance.rows - 1));
      focus();

      // Replay whatever arrived while the webfont was loading.
      for (const chunk of pending.splice(0)) {
        instance.write(chunk);
      }

      dataListener = instance.onData((data) => {
        if (!serviceRef.current.native || disposed || ended || checkpointing.current) {
          return;
        }
        void serviceRef.current.io.sshWrite(sessionId, encodeBase64(data)).catch(() => undefined);

        // Raw terminal input includes password prompts and program responses.
        // Capturing it requires an explicit user opt-in, separate from SSH I/O.
        if (!serviceRef.current.settings.read().recordTerminalHistory) {
          capture.current = { text: "", escape: 0 };
          return;
        }
        const result = consumeInput(capture.current, data);
        capture.current = result.state;
        for (const command of result.commands) {
          if (command.startsWith(" ")) {
            continue;
          }
          const hostId = serviceRef.current.session?.hostId;
          if (hostId) {
            void serviceRef.current.recordCommand(hostId, command).catch(() => undefined);
          }
        }
      });
      detachBridge = terminalBridge.attach(instance);
    };

    const started = start();

    // Listeners precede attach; restored screen/modes must precede new output.
    if (serviceRef.current.native) {
      const retain = (unlisten: UnlistenFn) => {
        if (disposed || registrationFailed) {
          unlisten();
        } else {
          subscriptions.push(unlisten);
        }
      };
      const fail = (error: unknown) => {
        if (disposed || registrationFailed) {
          return;
        }
        registrationFailed = true;
        serviceRef.current.failed?.(error);
        ended = true;
        terminalBridge.update({ status: "closed" });
        setClosed(true);
        subscriptions.splice(0).forEach((unlisten) => unlisten());
        const message = presentError(error);
        toast(message, "error");
        write(new TextEncoder().encode(`\r\n[${message}]\r\n`));
        // Keep the failed terminal visible, but release its remote PTY.
        if (serviceRef.current.releaseOnFailure)
          void serviceRef.current.io.sshDisconnect(sessionId).catch(() => undefined);
      };
      const dataReady = serviceRef.current.events
        .onSshData((payload) => {
          if (!disposed && payload.sessionId === sessionId) {
            if (payload.sequence <= sequence) return;
            write(decodeBase64(payload.data));
            sequence = payload.sequence ?? sequence + 1;
            sequenceWaiters.forEach((check) => check());
          }
        })
        .then(retain)
        .catch((error: unknown) => {
          fail(error);
          throw error;
        });

      const closedReady = serviceRef.current.events
        .onSshClosed((payload) => {
          if (disposed || payload.sessionId !== sessionId) {
            return;
          }
          ended = true;
          terminalBridge.update({ status: "closed" });
          sequenceWaiters.forEach((check) => check());
          setClosed(true);
          write(new TextEncoder().encode(`\r\n\x1b[38;5;245m[${t("ssh.closed")}]\x1b[0m\r\n`));
        })
        .then(retain)
        .catch((error: unknown) => {
          fail(error);
          throw error;
        });
      void Promise.all([dataReady, closedReady, started])
        .then(async () => {
          if (!disposed && !registrationFailed) {
            serviceRef.current.rendered?.();
          }
          if (!disposed && !registrationFailed && !ended) {
            await serviceRef.current.io.sshAttach(sessionId);
            if (!disposed) terminalBridge.update({ status: ended ? "closed" : "ready" });
          }
        })
        .catch(fail);
    }

    observer = new ResizeObserver(() => {
      runtime?.requestLayout();
    });
    observer.observe(element);

    // Late font swaps change glyph widths; re-measure once they settle.
    void document.fonts?.ready.then(() => {
      if (!disposed && terminal) {
        runtime?.requestLayout();
      }
    });

    void started.catch((error) => {
      if (!disposed) {
        serviceRef.current.failed?.(error);
        toast(presentError(error), "error");
      }
    });
    if (!serviceRef.current.native)
      void started.then(
        () => {
          if (!disposed) {
            serviceRef.current.rendered?.();
            terminalBridge.update({ status: "ready" });
          }
        },
        () => terminalBridge.update({ status: "closed" }),
      );

    return () => {
      disposed = true;
      unregisterShortcuts?.();
      checkpointing.current = false;
      unregisterCheckpoint?.();
      sequenceWaiters.forEach((check) => check());
      observer?.disconnect();
      subscriptions.forEach((unlisten) => unlisten());
      dataListener?.dispose();
      selectionListener?.dispose();
      applicationClipboard?.dispose();
      window.clearTimeout(selectionTimer);
      runtime?.dispose();
      detachBridge?.();
      terminalBridge.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      clipboardRef.current = null;
      pending.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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
          value={preferences.fontSelections?.mono ? "custom" : monoFont}
          options={
            preferences.fontSelections?.mono
              ? [
                  {
                    value: "custom",
                    label:
                      preferences.fontSelections.mono.source === "system"
                        ? preferences.fontSelections.mono.family
                        : t("fonts.mono"),
                  },
                  ...MONO_FONT_OPTIONS,
                ]
              : MONO_FONT_OPTIONS
          }
          onChange={(value) => {
            if (value !== "custom") void services.updateFont(value as MonoFont);
          }}
        />
        <IconButton
          label={t("history.title")}
          disabled={!session || closed}
          onClick={() => {
            if (session) {
              services.openHistory(session);
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
              services.openSftp(session);
            }
          }}
        >
          <FolderTree size={15} />
        </IconButton>
        <IconButton
          label={t("terminal.disconnect")}
          disabled={!session || closed || disconnecting}
          onClick={() => {
            void services.disconnect(sessionId);
          }}
        >
          <X size={15} />
        </IconButton>
      </header>
      <Surface
        bridge={bridge?.sessionId === sessionId ? bridge : null}
        visible={active}
        suspended={services.staged}
      >
        <div
          className="terminal-host"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const actions = clipboardRef.current;
            if (!actions) {
              return;
            }
            const mode = serviceRef.current.settings.read().terminalRightClick;
            if (!event.shiftKey && mode !== "menu") {
              useContextMenu.getState().close();
              if (mode === "copyPaste" && actions.hasSelection()) actions.copyAndClear();
              else actions.paste();
              return;
            }
            useContextMenu.getState().open(event.clientX, event.clientY, [
              {
                label: t("terminal.copy"),
                disabled: !actions.hasSelection(),
                onSelect: actions.copy,
              },
              {
                label: t("terminal.paste"),
                disabled: !actions.canPaste(),
                onSelect: actions.paste,
              },
              {
                label: t("terminal.selectAll"),
                separatorBefore: true,
                onSelect: actions.selectAll,
              },
            ]);
          }}
        >
          <div className="terminal-surface" ref={containerRef} />
        </div>
      </Surface>
    </div>
  );
}
