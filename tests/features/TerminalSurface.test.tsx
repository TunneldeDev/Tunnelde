import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { TerminalSurface } from "@/features/terminal/TerminalSurface";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type {
  FrontendTerminal,
  FrontendViewProps,
  FrontendTerminalChange,
} from "@/lib/extensions/uiSdkContract";
import type { TerminalBridge } from "@/lib/extensions/terminal/bridge";
import type { PluginInfo } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { uiProviders } from "@/lib/extensions/providers";

const plugin = {
  id: "terminal-ui",
  name: "Terminal UI",
  status: "running",
  fingerprint: "approved",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "sessions.read", "ssh.exec"],
  views: [{ id: "terminal", title: "Terminal", kind: "component", provider: "terminal" }],
} as PluginInfo;
const selected = { terminal: { pluginId: plugin.id, viewId: "terminal" } };
let retained: FrontendTerminal;
const subscribers = new Set<(change: Readonly<FrontendTerminalChange>) => void>();
const bridge = {
  api: {
    readState: vi.fn(() => ({ sessionId: "one", revision: 0 })),
    readLines: vi.fn(() => ({ lines: [] })),
    readSelection: vi.fn(),
    subscribe: vi.fn((receive: (change: Readonly<FrontendTerminalChange>) => void) => {
      subscribers.add(receive);
      return () => subscribers.delete(receive);
    }),
    focus: vi.fn(),
    paste: vi.fn(),
    send: vi.fn(),
    scrollToLine: vi.fn(),
    clearSelection: vi.fn(),
  },
} as unknown as TerminalBridge;
const received = vi.fn();
function Provider({ terminal }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = terminal!;
  });
  useEffect(() => terminal!.subscribe(received), [terminal]);
  const Screen = terminal!.Screen;
  return (
    <section aria-label="custom terminal">
      <Screen />
    </section>
  );
}
beforeEach(() => {
  mockCommittedViewScopes();
  vi.clearAllMocks();
  subscribers.clear();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: false } }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function choose() {
  act(() => useSettings.setState((s) => ({ settings: { ...s.settings, uiProviders: selected } })));
}
function fixture() {
  return render(
    <TerminalSurface bridge={bridge} visible>
      <input aria-label="live terminal" defaultValue="draft" />
    </TerminalSurface>,
  );
}
it("moves the same screen and input into a provider and back, then rejects retained contexts", () => {
  const view = fixture();
  const input = screen.getByLabelText("live terminal");
  fireEvent.change(input, { target: { value: "unsent" } });
  choose();
  expect(screen.getByRole("region", { name: "custom terminal" }).contains(input)).toBe(true);
  retained.send("pwd\r");
  expect(bridge.api.send).toHaveBeenCalledWith("pwd\r");
  const old = retained;
  expect(subscribers.size).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(screen.getByLabelText("live terminal")).toBe(input);
  expect(input).toHaveProperty("value", "unsent");
  expect(subscribers.size).toBe(0);
  for (const call of [
    () => old.send("x"),
    () => old.readState(),
    () => old.readLines(),
    () => old.subscribe(received),
  ])
    expect(call).toThrow("viewUnavailable");
  choose();
  const closing = retained;
  view.unmount();
  expect(subscribers.size).toBe(0);
  expect(() => closing.readState()).toThrow("viewUnavailable");
});
it("cleans subscriptions even if the plugin forgets, and fences reads on stop or revocation", () => {
  vi.mocked(frontendRuntime.view).mockReturnValue(({ terminal }) => {
    useLayoutEffect(() => {
      retained = terminal!;
    });
    useEffect(() => {
      terminal!.subscribe(received);
    }, [terminal]);
    const Screen = terminal!.Screen;
    return <Screen />;
  });
  choose();
  fixture();
  const old = retained;
  expect(subscribers.size).toBe(1);
  act(() => usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] }));
  expect(subscribers.size).toBe(0);
  expect(() => old.readSelection()).toThrow("viewUnavailable");
  act(() => usePlugins.setState({ items: [plugin] }));
  const running = retained;
  act(() => usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: true } })));
  expect(subscribers.size).toBe(0);
  expect(() => running.send("x")).toThrow("viewUnavailable");
  expect(screen.getByLabelText("live terminal")).toBeTruthy();
});
it("restores the terminal after missing, duplicate or subsequently removed screens", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  choose();
  vi.mocked(frontendRuntime.view).mockReturnValue(() => <span>No screen</span>);
  const missing = fixture();
  expect(screen.getByRole("alert").textContent).toContain("screen mounted");
  expect(screen.getByLabelText("live terminal")).toBeTruthy();
  missing.unmount();
  vi.mocked(frontendRuntime.view).mockReturnValue(({ terminal }) => {
    const Screen = terminal!.Screen;
    return (
      <>
        <Screen />
        <Screen />
      </>
    );
  });
  const duplicate = fixture();
  expect(screen.getByRole("alert").textContent).toContain("more than once");
  duplicate.unmount();
  vi.mocked(frontendRuntime.view).mockReturnValue(({ terminal }) => {
    const [show, setShow] = useState(true);
    const Screen = terminal!.Screen;
    return (
      <>
        <button onClick={() => setShow(false)}>Remove screen</button>
        {show && <Screen />}
      </>
    );
  });
  fixture();
  const input = screen.getByLabelText("live terminal");
  fireEvent.click(screen.getByRole("button", { name: "Remove screen" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByLabelText("live terminal")).toBe(input);
});
it("survives StrictMode lifecycle replay without duplicating subscriptions or replacing its screen", () => {
  choose();
  render(
    <StrictMode>
      <TerminalSurface bridge={bridge} visible>
        <input aria-label="live terminal" />
      </TerminalSurface>
    </StrictMode>,
  );
  expect(screen.getByRole("region", { name: "custom terminal" })).toBeTruthy();
  expect(subscribers.size).toBe(1);
  retained.paste("one\ntwo");
  expect(bridge.api.paste).toHaveBeenCalledWith("one\ntwo");
});
it("requires trusted terminal permissions and keeps built-in UI during initialization", () => {
  for (const permission of plugin.permissions) {
    expect(
      uiProviders(
        [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== permission) }],
        "terminal",
      ),
    ).toEqual([]);
  }
  choose();
  render(
    <TerminalSurface bridge={null} visible>
      <input aria-label="live terminal" />
    </TerminalSurface>,
  );
  expect(frontendRuntime.ensure).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "custom terminal" })).toBeNull();
  expect(screen.getByLabelText("live terminal")).toBeTruthy();
});

it("removes a throwing subscriber and fences a notification before React commits revocation", () => {
  choose();
  fixture();
  const bad = vi.fn(() => {
    throw new Error("isolated subscriber failure");
  });
  retained.subscribe(bad);
  const emit = () =>
    [...subscribers].forEach((receive) => receive({ revision: 1, changes: ["output"] }));
  act(emit);
  expect(bad).toHaveBeenCalledOnce();
  expect(subscribers.size).toBe(1);
  const previous = received.mock.calls.length;
  act(() => {
    usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: true } }));
    emit();
  });
  expect(received).toHaveBeenCalledTimes(previous);
  expect(subscribers.size).toBe(0);
});
