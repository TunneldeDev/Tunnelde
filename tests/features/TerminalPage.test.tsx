// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, eventMock, instances, inputs } = vi.hoisted(() => ({
  apiMock: { sshResize: vi.fn(), sshWrite: vi.fn(), historyRecord: vi.fn() },
  eventMock: { onSshData: vi.fn(), onSshClosed: vi.fn() },
  instances: [] as Array<{
    options: Record<string, unknown>;
    focus: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  inputs: [] as Array<(data: string) => void>,
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock, events: eventMock, isTauri: () => true }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    focus = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
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

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  instances.length = 0;
  inputs.length = 0;
  vi.clearAllMocks();
  apiMock.sshResize.mockResolvedValue(undefined);
  apiMock.sshWrite.mockResolvedValue(undefined);
  apiMock.historyRecord.mockResolvedValue(undefined);
  eventMock.onSshData.mockResolvedValue(vi.fn());
  eventMock.onSshClosed.mockResolvedValue(vi.fn());
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useDialogs.setState({ dialog: { kind: "none" } });
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
  });
});
