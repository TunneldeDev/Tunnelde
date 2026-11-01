// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { StrictMode } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMock,
  eventMock,
  instances,
  inputs,
  keyboard,
  copyMock,
  webglInstances,
  webglState,
  contextLoss,
} = vi.hoisted(() => ({
  apiMock: {
    sshResize: vi.fn(),
    sshWrite: vi.fn(),
    historyRecord: vi.fn(),
    sshAttach: vi.fn(),
    sshDisconnect: vi.fn(),
    clipboardReadText: vi.fn(),
  },
  eventMock: { onSshData: vi.fn(), onSshClosed: vi.fn() },
  instances: [] as Array<{
    options: Record<string, unknown>;
    focus: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
    selectAll: ReturnType<typeof vi.fn>;
    hasSelection: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  }>,
  inputs: [] as Array<(data: string) => void>,
  keyboard: [] as Array<(event: KeyboardEvent) => boolean>,
  copyMock: vi.fn(),
  webglState: { failLoad: false },
  webglInstances: [] as Array<{
    activate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  }>,
  contextLoss: [] as Array<() => void>,
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock, events: eventMock, isTauri: () => true }));
vi.mock("@/lib/session/clipboard", () => ({ copyText: copyMock }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate = vi.fn(() => {
      if (webglState.failLoad) {
        throw new Error("WebGL2 unavailable");
      }
    });
    dispose = vi.fn();
    unsubscribe = vi.fn();
    onContextLoss = vi.fn((callback: () => void) => {
      contextLoss.push(callback);
      return { dispose: this.unsubscribe };
    });
    constructor() {
      webglInstances.push(this);
    }
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    focus = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    paste = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "selected text");
    attachCustomKeyEventHandler = vi.fn((callback: (event: KeyboardEvent) => boolean) => {
      keyboard.push(callback);
    });
    loadAddon = vi.fn((addon: { activate?: (terminal: unknown) => void }) => {
      addon.activate?.(this);
    });
    open = vi.fn();
    refresh = vi.fn();
    onData = vi.fn((callback: (data: string) => void) => {
      inputs.push(callback);
      return { dispose: vi.fn() };
    });
    rows = 24;
    cols = 80;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
  },
}));

import "@/i18n/i18n";
import { TerminalPage } from "@/features/terminal/TerminalPage";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { terminalTheme } from "@/features/terminal/terminalTheme";
import { useContextMenu } from "@/store/contextMenu";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  instances.length = 0;
  inputs.length = 0;
  keyboard.length = 0;
  webglInstances.length = 0;
  contextLoss.length = 0;
  webglState.failLoad = false;
  vi.clearAllMocks();
  apiMock.sshResize.mockResolvedValue(undefined);
  apiMock.sshWrite.mockResolvedValue(undefined);
  apiMock.historyRecord.mockResolvedValue(undefined);
  apiMock.sshAttach.mockResolvedValue(undefined);
  apiMock.sshDisconnect.mockResolvedValue(undefined);
  apiMock.clipboardReadText.mockResolvedValue("pasted\ntext");
  eventMock.onSshData.mockResolvedValue(vi.fn());
  eventMock.onSshClosed.mockResolvedValue(vi.fn());
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useDialogs.setState({ dialog: { kind: "none" } });
  useContextMenu.setState({ menu: null });
  useSsh.setState({
    sessions: [
      {
        id: "s1",
        hostId: "h1",
        title: "host",
        address: "host:22",
        cols: 80,
        rows: 24,
        connectedAt: 0,
      },
    ],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]), ready: Promise.resolve() },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalFonts) {
    Object.defineProperty(document, "fonts", originalFonts);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
});

describe("terminal lifecycle", () => {
  it("loads GPU rendering after opening the terminal and releases it on unmount", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(webglInstances).toHaveLength(1));
    const gpu = webglInstances[0]!;
    const terminal = instances[0]!;
    expect(gpu.activate).toHaveBeenCalledWith(terminal);
    expect(terminal.open.mock.invocationCallOrder[0]).toBeLessThan(
      gpu.activate.mock.invocationCallOrder[0]!,
    );
    expect(terminal.options.allowProposedApi).toBe(false);
    expect(gpu.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps terminal I/O working when WebGL activation fails", async () => {
    webglState.failLoad = true;
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    expect(webglInstances[0]!.dispose).toHaveBeenCalledOnce();
    expect(webglInstances[0]!.unsubscribe).toHaveBeenCalledOnce();
    inputs[0]!("pwd\r");
    expect(apiMock.sshWrite).toHaveBeenCalled();
    await act(async () => {
      eventMock.onSshData.mock.calls[0]![0]({ sessionId: "s1", data: "aGk=" });
    });
    expect(new TextDecoder().decode(instances[0]!.write.mock.calls[0]![0])).toBe("hi");
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
  });

  it("falls back and redraws on context loss without disconnecting or disposing twice", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(contextLoss).toHaveLength(1));
    const gpu = webglInstances[0]!;
    const terminal = instances[0]!;
    const refreshes = terminal.refresh.mock.calls.length;
    act(() => contextLoss[0]!());
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.unsubscribe).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledTimes(refreshes + 1);
    inputs[0]!("pwd\r");
    expect(apiMock.sshWrite).toHaveBeenCalled();
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
    view.unmount();
    act(() => contextLoss[0]!());
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledTimes(refreshes + 1);
  });

  it("records terminal input only after an explicit history opt-in", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    inputs[0]!("password-response\r");
    expect(apiMock.sshWrite).toHaveBeenCalled();
    expect(apiMock.historyRecord).not.toHaveBeenCalled();
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, recordTerminalHistory: true } }),
    );
    inputs[0]!(" secret-command\r");
    expect(apiMock.historyRecord).not.toHaveBeenCalled();
    inputs[0]!("pwd\r");
    expect(apiMock.historyRecord).toHaveBeenCalledWith("h1", "pwd");
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, recordTerminalHistory: false } }),
    );
    inputs[0]!("another-password\r");
    expect(apiMock.historyRecord).toHaveBeenCalledTimes(1);
  });

  it("uses preferences changed while its first font was loading", async () => {
    let finishFont!: () => void;
    vi.mocked(document.fonts.load).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFont = () => resolve([]);
        }),
    );
    render(<TerminalPage sessionId="s1" active={false} />);
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          theme: "light",
          monoFont: "jetbrains-mono",
          monoFontSize: 18,
        },
      }),
    );
    await act(async () => finishFont());
    await waitFor(() => expect(instances).toHaveLength(1));
    const terminal = instances[0]!;
    expect(terminal.options.fontFamily).toContain("JetBrains Mono");
    expect(terminal.options.fontSize).toBe(18);
    expect(terminal.options.theme).toEqual(terminalTheme("light"));
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("unsubscribes registrations that finish after unmount", async () => {
    const unlisten = vi.fn();
    let register!: (unsubscribe: () => void) => void;
    eventMock.onSshData.mockImplementation(
      () =>
        new Promise((resolve) => {
          register = resolve;
        }),
    );
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    view.unmount();
    await act(async () => register(unlisten));
    expect(unlisten).toHaveBeenCalledOnce();
    const callback = eventMock.onSshData.mock.calls[0]?.[0];
    callback({ sessionId: "s1", data: "aGk=" });
    expect(instances[0]?.write).not.toHaveBeenCalled();
    expect(apiMock.sshAttach).not.toHaveBeenCalled();
  });

  it("attaches only after both listeners exist and retains early ANSI output during font loading", async () => {
    let registerClosed!: (unsubscribe: () => void) => void;
    let finishFont!: () => void;
    eventMock.onSshClosed.mockImplementation(
      () =>
        new Promise((resolve) => {
          registerClosed = resolve;
        }),
    );
    vi.mocked(document.fonts.load).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFont = () => resolve([]);
        }),
    );
    apiMock.sshAttach.mockImplementation(async () => {
      eventMock.onSshData.mock.calls[0]![0]({ sessionId: "s1", data: "G1szMm1wcm9tcHQbWzBt" });
    });
    render(<TerminalPage sessionId="s1" active={false} />);
    await act(async () => undefined);
    expect(apiMock.sshAttach).not.toHaveBeenCalled();
    await act(async () => registerClosed(vi.fn()));
    expect(apiMock.sshAttach).toHaveBeenCalledWith("s1");
    expect(instances).toHaveLength(0);
    await act(async () => finishFont());
    expect(new TextDecoder().decode(instances[0]!.write.mock.calls[0]![0])).toBe(
      "\x1b[32mprompt\x1b[0m",
    );
  });

  it("cleans up a late successful listener when its peer fails and releases the remote PTY", async () => {
    let register!: (unsubscribe: () => void) => void;
    const unlisten = vi.fn();
    eventMock.onSshData.mockRejectedValue(new Error("listener unavailable"));
    eventMock.onSshClosed.mockImplementation(
      () =>
        new Promise((resolve) => {
          register = resolve;
        }),
    );
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(apiMock.sshDisconnect).toHaveBeenCalledWith("s1"));
    await act(async () => register(unlisten));
    expect(unlisten).toHaveBeenCalledOnce();
    expect(apiMock.sshAttach).not.toHaveBeenCalled();
    expect(instances[0]?.write).toHaveBeenCalled();
  });

  it("handles attach failure visibly and disconnects its PTY", async () => {
    apiMock.sshAttach.mockRejectedValue(new Error("attach unavailable"));
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(apiMock.sshDisconnect).toHaveBeenCalledWith("s1"));
    expect(instances[0]?.write).toHaveBeenCalled();
  });

  it("does not attach the disposed StrictMode setup", async () => {
    render(
      <StrictMode>
        <TerminalPage sessionId="s1" active={false} />
      </StrictMode>,
    );
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(eventMock.onSshData).toHaveBeenCalledTimes(2);
    expect(apiMock.sshAttach).toHaveBeenCalledTimes(1);
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
  });
});

describe("terminal clipboard", () => {
  it("uses the native clipboard bridge and xterm paste for Shift+Insert", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(keyboard).toHaveLength(1));
    const event = new KeyboardEvent("keydown", {
      key: "Insert",
      shiftKey: true,
      cancelable: true,
    });
    expect(keyboard[0]!(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(apiMock.clipboardReadText).toHaveBeenCalledOnce();
    await waitFor(() => expect(instances[0]!.paste).toHaveBeenCalledWith("pasted\ntext"));
    expect(apiMock.sshWrite).not.toHaveBeenCalled();
  });

  it("copies the selection for Ctrl+Insert and consumes the browser shortcut", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(keyboard).toHaveLength(1));
    instances[0]!.hasSelection.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", {
      key: "Insert",
      ctrlKey: true,
      cancelable: true,
    });
    expect(keyboard[0]!(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(copyMock).toHaveBeenCalledWith("selected text");
    expect(apiMock.clipboardReadText).not.toHaveBeenCalled();
    expect(apiMock.sshWrite).not.toHaveBeenCalled();
  });

  it("pastes through xterm for Ctrl+V and Ctrl+Shift+V without emitting control bytes", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(keyboard).toHaveLength(1));
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent("keydown", {
        key: "v",
        ctrlKey: true,
        shiftKey,
        cancelable: true,
      });
      expect(keyboard[0]!(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    await waitFor(() => expect(instances[0]!.paste).toHaveBeenCalledTimes(2));
    expect(instances[0]!.paste).toHaveBeenCalledWith("pasted\ntext");
    expect(apiMock.sshWrite).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+C as SIGINT without a selection, copies selected text, and ignores IME", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(keyboard).toHaveLength(1));
    expect(keyboard[0]!(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    instances[0]!.hasSelection.mockReturnValue(true);
    expect(keyboard[0]!(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false);
    expect(copyMock).toHaveBeenCalledWith("selected text");
    expect(
      keyboard[0]!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, isComposing: true })),
    ).toBe(true);
    expect(apiMock.clipboardReadText).not.toHaveBeenCalled();
  });

  it("supports macOS Command shortcuts", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      render(<TerminalPage sessionId="s1" active={false} />);
      await waitFor(() => expect(keyboard).toHaveLength(1));
      instances[0]!.hasSelection.mockReturnValue(true);
      expect(keyboard[0]!(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false);
      expect(copyMock).toHaveBeenCalledWith("selected text");
      expect(
        keyboard[0]!(new KeyboardEvent("keydown", { key: "v", metaKey: true, shiftKey: true })),
      ).toBe(false);
      await waitFor(() => expect(instances[0]!.paste).toHaveBeenCalled());
    } finally {
      if (original) {
        Object.defineProperty(navigator, "platform", original);
      } else {
        Reflect.deleteProperty(navigator, "platform");
      }
    }
  });

  it("opens copy, paste and select-all actions in the terminal context menu", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    fireEvent.contextMenu(view.container.querySelector(".terminal-host")!, {
      clientX: 20,
      clientY: 30,
    });
    const menu = useContextMenu.getState().menu!;
    expect([menu.x, menu.y]).toEqual([20, 30]);
    expect(menu.items).toHaveLength(3);
    expect(menu.items[0]!.disabled).toBe(true);
    menu.items[1]!.onSelect();
    await waitFor(() => expect(instances[0]!.paste).toHaveBeenCalledWith("pasted\ntext"));
    menu.items[2]!.onSelect();
    expect(instances[0]!.selectAll).toHaveBeenCalledOnce();
  });

  it("does not paste after unmount or after the remote session closes", async () => {
    let read!: (text: string) => void;
    apiMock.clipboardReadText.mockImplementation(
      () =>
        new Promise((resolve) => {
          read = resolve;
        }),
    );
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(keyboard).toHaveLength(1));
    keyboard[0]!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }));
    await act(async () => {
      eventMock.onSshClosed.mock.calls[0]![0]({ sessionId: "s1" });
    });
    await act(async () => read("late text"));
    expect(instances[0]!.paste).not.toHaveBeenCalled();
    view.unmount();
    keyboard[0]!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }));
    expect(apiMock.clipboardReadText).toHaveBeenCalledTimes(1);
  });
});
