import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  selections,
  oscHandlers,
} = vi.hoisted(() => ({
  apiMock: {
    sshResize: vi.fn(),
    sshWrite: vi.fn(),
    historyRecord: vi.fn(),
    historyList: vi.fn(),
    sshAttach: vi.fn(),
    sshDisconnect: vi.fn(),
    clipboardReadText: vi.fn(),
    clipboardWriteText: vi.fn(),
  },
  eventMock: { onSshData: vi.fn(), onSshClosed: vi.fn() },
  instances: [] as Array<{
    options: Record<string, unknown>;
    focus: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    selectAll: ReturnType<typeof vi.fn>;
    hasSelection: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    modes: { mouseTrackingMode: string };
    open: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    unicode: { activeVersion: string; register: ReturnType<typeof vi.fn> };
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
  selections: [] as Array<() => void>,
  oscHandlers: [] as Array<(data: string) => boolean | Promise<boolean>>,
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock, events: eventMock, isTauri: () => true }));
vi.mock("@/lib/session/clipboard", () => ({ copyText: copyMock }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    activate = vi.fn();
    serialize = vi.fn(() => "");
    dispose = vi.fn();
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
    input = vi.fn((data: string) => inputs[instances.indexOf(this)]?.(data));
    selectAll = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "selected text");
    clearSelection = vi.fn(() => this.hasSelection.mockReturnValue(false));
    modes = { mouseTrackingMode: "none" };
    onSelectionChange = vi.fn((callback: () => void) => {
      selections.push(callback);
      return { dispose: vi.fn() };
    });
    attachCustomKeyEventHandler = vi.fn((callback: (event: KeyboardEvent) => boolean) => {
      keyboard.push(callback);
    });
    loadAddon = vi.fn((addon: { activate?: (terminal: unknown) => void }) => {
      addon.activate?.(this);
    });
    open = vi.fn();
    refresh = vi.fn();
    parser = {
      registerOscHandler: vi.fn(
        (_id: number, callback: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.push(callback);
          return { dispose: vi.fn() };
        },
      ),
    };
    unicode = { activeVersion: "6", register: vi.fn() };
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
import { TerminalPreview } from "@/features/terminal/TerminalPreview";
import { HistoryPage } from "@/features/history/HistoryPage";
import { encodeBase64 } from "@/lib/text/base64";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { terminalTheme } from "@/features/terminal/terminalTheme";
import { useContextMenu } from "@/store/contextMenu";
import { previewColors } from "@/lib/prefs/colors";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  previewColors(null);
  instances.length = 0;
  inputs.length = 0;
  keyboard.length = 0;
  webglInstances.length = 0;
  contextLoss.length = 0;
  selections.length = 0;
  oscHandlers.length = 0;
  webglState.failLoad = false;
  vi.clearAllMocks();
  apiMock.sshResize.mockResolvedValue(undefined);
  apiMock.sshWrite.mockResolvedValue(undefined);
  apiMock.historyRecord.mockResolvedValue(undefined);
  apiMock.historyList.mockReset().mockResolvedValue([]);
  apiMock.sshAttach.mockResolvedValue(undefined);
  apiMock.sshDisconnect.mockResolvedValue(undefined);
  apiMock.clipboardReadText.mockResolvedValue("pasted\ntext");
  apiMock.clipboardWriteText.mockResolvedValue(undefined);
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
  vi.useRealTimers();
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
    expect(terminal.options.allowProposedApi).toBe(true);
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
    expect(instances[0]!.write.mock.calls[0]![0]).toBe("hi");
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
  });

  it("falls back and redraws on context loss without disconnecting or disposing twice", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(contextLoss).toHaveLength(1));
    const gpu = webglInstances[0]!;
    const terminal = instances[0]!;
    act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](0));
    const refreshes = terminal.refresh.mock.calls.length;
    act(() => contextLoss[0]!());
    act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](0));
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
    vi.mocked(document.fonts.load).mockImplementationOnce(
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
          terminalLineHeight: 1.6,
          terminalScrollback: 25_000,
          terminalCursorStyle: "underline",
          terminalRenderer: "dom",
        },
      }),
    );
    await act(async () => finishFont());
    await waitFor(() => expect(instances).toHaveLength(1));
    const terminal = instances[0]!;
    expect(terminal.options.fontFamily).toContain("JetBrains Mono");
    expect(terminal.options.fontSize).toBe(18);
    expect(terminal.options.theme).toEqual(terminalTheme("light"));
    expect(terminal.options.lineHeight).toBe(1.6);
    expect(terminal.options.scrollback).toBe(25_000);
    expect(terminal.options.cursorStyle).toBe("underline");
    expect(terminal.options.allowProposedApi).toBe(true);
    expect(terminal.unicode.activeVersion).toBe("15-graphemes");
    const provider = terminal.unicode.register.mock.calls[1]![0];
    expect(provider.wcwidth("❌".codePointAt(0))).toBe(2);
    expect(provider.wcwidth("中".codePointAt(0))).toBe(2);
    expect(provider.wcwidth("①".codePointAt(0))).toBe(1);
    expect(document.fonts.load).toHaveBeenLastCalledWith('18px "JetBrains Mono"');
    expect(webglInstances).toHaveLength(0);
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

  it("attaches after both listeners and the terminal are ready, retaining the first ANSI bytes", async () => {
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
    expect(apiMock.sshAttach).not.toHaveBeenCalled();
    expect(instances).toHaveLength(0);
    await act(async () => finishFont());
    expect(apiMock.sshAttach).toHaveBeenCalledWith("s1");
    expect(instances[0]!.write.mock.calls[0]![0]).toBe("\x1b[32mprompt\x1b[0m");
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

describe("live terminal settings", () => {
  it("waits for the requested glyphs and rejects a font load that finishes after a newer choice", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    const terminal = instances[0]!;
    const loads: Array<() => void> = [];
    vi.mocked(document.fonts.load).mockImplementation(
      () =>
        new Promise((resolve) => {
          loads.push(() => resolve([]));
        }),
    );
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monoFont: "jetbrains-mono" } }),
    );
    expect(terminal.options.fontFamily).toContain("Fira Code");
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, monoFont: "plex-mono", monoFontSize: 19 },
      }),
    );
    expect(loads).toHaveLength(2);
    await act(async () => loads[1]!());
    expect(terminal.options.fontFamily).toContain("IBM Plex Mono");
    expect(terminal.options.fontSize).toBe(19);
    await act(async () => loads[0]!());
    expect(terminal.options.fontFamily).toContain("IBM Plex Mono");
    expect(terminal.options.fontSize).toBe(19);
    expect(instances).toHaveLength(1);
  });

  it("coalesces font metrics and renderer layout work into a frame and cancels it on unmount", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](0));
    vi.mocked(requestAnimationFrame).mockClear();
    const terminal = instances[0]!;
    const refreshes = terminal.refresh.mock.calls.length;
    act(() => {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalLineHeight: 1.3 } });
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, terminalLineHeight: 1.5, terminalRenderer: "dom" },
      });
    });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledTimes(refreshes);
    const redraw = vi.mocked(requestAnimationFrame).mock.calls[0]![0];
    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    act(() => redraw(0));
    expect(terminal.refresh).toHaveBeenCalledTimes(refreshes);
  });

  it("updates appearance and behavior in place while preserving output and the SSH session", async () => {
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    const terminal = instances[0]!;
    await act(async () => {
      eventMock.onSshData.mock.calls[0]![0]({ sessionId: "s1", data: "YmVmb3Jl" });
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          terminalScrollback: 50_000,
          terminalLineHeight: 1.5,
          terminalCursorStyle: "bar",
          terminalCursorBlink: false,
          terminalInactiveCursorStyle: "none",
          terminalScrollSensitivity: 3,
          terminalSmoothScrolling: true,
          terminalScrollOnInput: false,
          motion: "full",
          theme: "light",
          monoFont: "jetbrains-mono",
          monoFontSize: 17,
        },
      });
      eventMock.onSshData.mock.calls[0]![0]({ sessionId: "s1", data: "YWZ0ZXI=" });
    });
    expect(terminal.options).toMatchObject({
      scrollback: 50_000,
      lineHeight: 1.5,
      cursorStyle: "bar",
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollSensitivity: 3,
      smoothScrollDuration: 100,
      scrollOnUserInput: false,
      fontSize: 17,
      theme: terminalTheme("light"),
    });
    expect(terminal.options.fontFamily).toContain("JetBrains Mono");
    expect(terminal.write.mock.calls.map(([chunk]) => chunk)).toEqual(["before", "after"]);
    expect(instances).toHaveLength(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(apiMock.sshAttach).toHaveBeenCalledTimes(1);
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
  });

  it("switches renderers without reconnecting, and retries a failed GPU only after a deliberate switch", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalRenderer: "dom" } });
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    expect(webglInstances).toHaveLength(0);
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalRenderer: "auto" } }),
    );
    expect(webglInstances).toHaveLength(1);
    const first = webglInstances[0]!;
    act(() => contextLoss[0]!());
    expect(first.dispose).toHaveBeenCalledOnce();
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalLineHeight: 1.4 } }));
    expect(webglInstances).toHaveLength(1);
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalRenderer: "dom" } }));
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalRenderer: "auto" } }),
    );
    expect(webglInstances).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
    expect(apiMock.sshAttach).toHaveBeenCalledTimes(1);
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
    view.unmount();
    expect(webglInstances[1]!.dispose).toHaveBeenCalledOnce();
  });

  it("releases the GPU in lightweight mode and restores the saved renderer without reconnecting", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    expect(webglInstances).toHaveLength(1);
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, lightweightMode: true } }));
    expect(webglInstances[0]!.dispose).toHaveBeenCalledOnce();
    expect(useSettings.getState().settings.terminalRenderer).toBe("auto");
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, lightweightMode: false } }));
    expect(webglInstances).toHaveLength(2);
    expect(instances).toHaveLength(1);
    expect(apiMock.sshAttach).toHaveBeenCalledTimes(1);
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
    view.unmount();
  });

  it("follows OS reduced motion live and honors explicit motion overrides", async () => {
    let changed!: () => void;
    const motion = {
      matches: false,
      addEventListener: vi.fn((_event: string, callback: () => void) => {
        changed = callback;
      }),
      removeEventListener: vi.fn(),
    };
    const light = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.mocked(matchMedia).mockImplementation(
      (query) => (query.includes("reduced-motion") ? motion : light) as unknown as MediaQueryList,
    );
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalSmoothScrolling: true } });
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    expect(instances[0]!.options.smoothScrollDuration).toBe(100);
    act(() => {
      motion.matches = true;
      changed();
    });
    expect(instances[0]!.options.smoothScrollDuration).toBe(0);
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, terminalSmoothScrolling: true, motion: "full" },
      }),
    );
    expect(instances[0]!.options.smoothScrollDuration).toBe(100);
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, terminalSmoothScrolling: true, motion: "reduced" },
      }),
    );
    expect(instances[0]!.options.smoothScrollDuration).toBe(0);
    view.unmount();
    expect(motion.removeEventListener).toHaveBeenCalledWith("change", changed);
  });
});

describe("local terminal preview", () => {
  it("applies live regional previews and cancellation to an existing terminal without reconnecting", async () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        colors: { terminalBackground: "#112233", terminalForeground: "#aabbcc" },
      },
    });
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(inputs).toHaveLength(1));
    const terminal = instances[0]!;
    const initial = terminal.options.theme as Record<string, unknown>;
    const attaches = apiMock.sshAttach.mock.calls.length;
    act(() =>
      previewColors({ colors: { terminalBackground: "#445566", terminalCursor: "#ffaa00" } }),
    );
    expect(terminal.options.theme).toEqual({
      ...initial,
      background: "#445566",
      cursorAccent: "#445566",
      cursor: "#ffaa00",
    });
    expect(instances).toHaveLength(1);
    expect(apiMock.sshAttach).toHaveBeenCalledTimes(attaches);
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          theme: "light",
          colors: { terminalBackground: "#778899", terminalForeground: "#abcdef" },
        },
      }),
    );
    expect((terminal.options.theme as Record<string, unknown>).background).toBe("#445566");
    act(() => previewColors(null));
    expect(terminal.options.theme).toEqual(
      terminalTheme("light", { terminalBackground: "#778899", terminalForeground: "#abcdef" }),
    );
    expect(instances).toHaveLength(1);
    expect(apiMock.sshAttach).toHaveBeenCalledTimes(attaches);
    view.unmount();
    const saved = terminal.options.theme;
    act(() => previewColors({ colors: { terminalBackground: "#ffffff" } }));
    expect(terminal.options.theme).toBe(saved);
    previewColors(null);
  });

  it("previews preferences live without creating an SSH session and releases resources", async () => {
    const view = render(<TerminalPreview />);
    await waitFor(() => expect(instances).toHaveLength(1));
    const terminal = instances[0]!;
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.unicode.activeVersion).toBe("15-graphemes");
    expect(terminal.write).toHaveBeenCalledWith(expect.stringContaining("user@tunnelde"));
    expect(eventMock.onSshData).not.toHaveBeenCalled();
    expect(apiMock.sshAttach).not.toHaveBeenCalled();
    expect(apiMock.sshWrite).not.toHaveBeenCalled();
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          terminalCursorStyle: "underline",
          terminalLineHeight: 1.4,
          terminalRenderer: "dom",
          terminalScrollback: 0,
        },
      }),
    );
    expect(terminal.options.cursorStyle).toBe("underline");
    expect(terminal.options.lineHeight).toBe(1.4);
    expect(terminal.options.scrollback).toBe(100);
    expect(webglInstances[0]!.dispose).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
    view.unmount();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalCursorStyle: "bar" } }),
    );
    expect(terminal.options.cursorStyle).toBe("underline");
    expect(webglInstances[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("does not create a preview when font loading finishes after unmount", async () => {
    let finishFont!: () => void;
    vi.mocked(document.fonts.load).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFont = () => resolve([]);
        }),
    );
    const view = render(<TerminalPreview />);
    view.unmount();
    await act(async () => finishFont());
    expect(instances).toHaveLength(0);
    expect(webglInstances).toHaveLength(0);
  });
});

describe("terminal clipboard", () => {
  it("forwards copy shortcuts to mouse-aware TUIs when their selection is not owned by xterm", async () => {
    render(<TerminalPage sessionId="s1" active />);
    await waitFor(() => expect(keyboard).toHaveLength(1));
    const terminal = instances[0]!;
    terminal.modes.mouseTrackingMode = "drag";
    const copy = () =>
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, cancelable: true });
    expect(keyboard[0]!(copy())).toBe(true);
    expect(copyMock).not.toHaveBeenCalled();
    terminal.hasSelection.mockReturnValue(true);
    expect(keyboard[0]!(copy())).toBe(false);
    expect(copyMock).toHaveBeenCalledWith("selected text");
  });

  it("copies the captured selection even if a TUI redraw clears it before the debounce", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalCopyOnSelect: true } });
    render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(selections).toHaveLength(1));
    vi.useFakeTimers();
    const terminal = instances[0]!;
    terminal.hasSelection.mockReturnValue(true);
    terminal.getSelection.mockReturnValue("selected before redraw");
    act(() => selections[0]!());
    terminal.hasSelection.mockReturnValue(false);
    terminal.getSelection.mockReturnValue("");
    act(() => {
      selections[0]!();
      vi.advanceTimersByTime(150);
    });
    expect(apiMock.clipboardWriteText).toHaveBeenCalledWith("selected before redraw");
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("accepts application OSC 52 independently of xterm copy-on-select and supports opting out", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalCopyOnSelect: false } });
    const view = render(<TerminalPage sessionId="s1" active />);
    await waitFor(() => expect(oscHandlers).toHaveLength(1));
    const surface = view.container.querySelector(".terminal-surface")!;
    const data = `c;${encodeBase64("Pi 中文 selection 👩‍💻")}`;
    oscHandlers[0]!(data);
    expect(apiMock.clipboardWriteText).not.toHaveBeenCalled();
    fireEvent.mouseDown(surface, { button: 0 });
    fireEvent.mouseUp(surface, { button: 0 });
    oscHandlers[0]!("c;?");
    expect(apiMock.clipboardReadText).not.toHaveBeenCalled();
    oscHandlers[0]!(data);
    expect(apiMock.clipboardWriteText).toHaveBeenCalledWith("Pi 中文 selection 👩‍💻");
    oscHandlers[0]!(data);
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, terminalApplicationClipboard: false },
    });
    fireEvent.mouseDown(surface, { button: 0 });
    fireEvent.mouseUp(surface, { button: 0 });
    oscHandlers[0]!(data);
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    view.rerender(<TerminalPage sessionId="s1" active={false} />);
    fireEvent.mouseDown(surface, { button: 0 });
    fireEvent.mouseUp(surface, { button: 0 });
    oscHandlers[0]!(data);
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
    view.unmount();
    oscHandlers[0]!(data);
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
  });

  it("debounces copy-on-select without stealing focus, and honors disabling and cleanup", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(selections).toHaveLength(1));
    vi.useFakeTimers();
    const terminal = instances[0]!;
    terminal.hasSelection.mockReturnValue(true);
    act(() => {
      selections[0]!();
      vi.advanceTimersByTime(200);
    });
    expect(apiMock.clipboardWriteText).not.toHaveBeenCalled();
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalCopyOnSelect: true } }),
    );
    act(() => {
      selections[0]!();
      selections[0]!();
      vi.advanceTimersByTime(150);
    });
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
    expect(apiMock.clipboardWriteText).toHaveBeenCalledWith("selected text");
    expect(terminal.focus).not.toHaveBeenCalled();
    act(() => {
      selections[0]!();
      vi.advanceTimersByTime(150);
    });
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
    terminal.getSelection.mockReturnValue("new selection");
    act(() => {
      selections[0]!();
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalCopyOnSelect: false } });
      vi.advanceTimersByTime(150);
    });
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalCopyOnSelect: true } }),
    );
    act(() => selections[0]!());
    view.unmount();
    act(() => vi.advanceTimersByTime(200));
    expect(apiMock.clipboardWriteText).toHaveBeenCalledOnce();
  });

  it("uses copy/paste right-click mode live, clears the copied selection, and always permits Shift+right-click", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    const host = view.container.querySelector(".terminal-host")!;
    const terminal = instances[0]!;
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalRightClick: "copyPaste" } }),
    );
    terminal.hasSelection.mockReturnValue(true);
    fireEvent.contextMenu(host);
    expect(copyMock).toHaveBeenCalledWith("selected text");
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
    expect(useContextMenu.getState().menu).toBeNull();
    fireEvent.contextMenu(host);
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith("pasted\ntext"));
    fireEvent.contextMenu(host, { shiftKey: true });
    expect(useContextMenu.getState().menu?.items).toHaveLength(3);
    expect(copyMock).toHaveBeenCalledOnce();
    expect(apiMock.clipboardReadText).toHaveBeenCalledOnce();
  });

  it("uses paste-only right-click mode even with a selection, with Shift opening the menu", async () => {
    const view = render(<TerminalPage sessionId="s1" active={false} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    const host = view.container.querySelector(".terminal-host")!;
    act(() =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalRightClick: "paste" } }),
    );
    instances[0]!.hasSelection.mockReturnValue(true);
    fireEvent.contextMenu(host);
    await waitFor(() => expect(instances[0]!.paste).toHaveBeenCalled());
    expect(copyMock).not.toHaveBeenCalled();
    fireEvent.contextMenu(host, { shiftKey: true });
    expect(useContextMenu.getState().menu?.items).toHaveLength(3);
  });

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
      expect(keyboard[0]!(new KeyboardEvent("keydown", { key: "a", metaKey: true }))).toBe(false);
      expect(instances[0]!.selectAll).toHaveBeenCalledOnce();
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

  it("sends macOS editing commands as input through the real SSH callback, never paste", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      render(<TerminalPage sessionId="s1" active />);
      await waitFor(() => expect(keyboard).toHaveLength(1));
      for (const [key, expected, modifier] of [
        ["ArrowLeft", "\x01", "metaKey"],
        ["ArrowRight", "\x05", "metaKey"],
        ["ArrowLeft", "\x1bb", "altKey"],
        ["ArrowRight", "\x1bf", "altKey"],
        ["Backspace", "\x15", "metaKey"],
        ["Delete", "\x0b", "metaKey"],
      ] as const) {
        const event = new KeyboardEvent("keydown", { key, [modifier]: true, cancelable: true });
        expect(keyboard[0]!(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(apiMock.sshWrite).toHaveBeenLastCalledWith("s1", encodeBase64(expected));
      }
      expect(instances[0]!.paste).not.toHaveBeenCalled();
      const composing = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        metaKey: true,
        isComposing: true,
      });
      const before = apiMock.sshWrite.mock.calls.length;
      expect(keyboard[0]!(composing)).toBe(true);
      expect(apiMock.sshWrite).toHaveBeenCalledTimes(before);
    } finally {
      if (original) Object.defineProperty(navigator, "platform", original);
      else Reflect.deleteProperty(navigator, "platform");
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

describe("live command history", () => {
  it("refreshes an already mounted history pane only after the terminal command is saved", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, recordTerminalHistory: true } });
    let save!: (entry: { id: number; hostId: string; command: string; executedAt: number }) => void;
    apiMock.historyRecord.mockReturnValueOnce(
      new Promise((resolve) => {
        save = resolve;
      }),
    );
    const view = render(
      <>
        <TerminalPage sessionId="s1" active={false} />
        <HistoryPage sessionId="s1" />
      </>,
    );
    await waitFor(() => expect(inputs).toHaveLength(1));
    await waitFor(() => expect(apiMock.historyList).toHaveBeenCalledTimes(1));
    act(() => inputs[0]!("pwd\r"));
    expect(apiMock.historyRecord).toHaveBeenCalledWith("h1", "pwd");
    expect(apiMock.historyList).toHaveBeenCalledTimes(1);
    const entry = { id: 1, hostId: "h1", command: "pwd", executedAt: Date.now() };
    apiMock.historyList.mockResolvedValue([entry]);
    await act(async () => save(entry));
    await view.findByText("pwd");
    expect(apiMock.historyList).toHaveBeenCalledTimes(2);
    apiMock.historyRecord.mockRejectedValueOnce(new Error("database unavailable"));
    await act(async () => inputs[0]!("ls\r"));
    expect(apiMock.historyList).toHaveBeenCalledTimes(2);
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS } }));
    await act(async () => inputs[0]!("whoami\r"));
    expect(apiMock.historyRecord).toHaveBeenCalledTimes(2);
    expect(apiMock.historyList).toHaveBeenCalledTimes(2);
  });
});

it("keeps forwarding out of the terminal toolbar", () => {
  render(<TerminalPage sessionId="s1" active />);
  expect(screen.queryByRole("button", { name: "Port forwarding" })).toBeNull();
});
