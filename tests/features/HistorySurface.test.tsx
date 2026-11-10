import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { HistorySurface } from "@/features/history/HistorySurface";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { FrontendHistory, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import type { PluginInfo } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { uiProviders } from "@/lib/extensions/providers";

const plugin = {
  id: "history-ui",
  name: "History UI",
  status: "running",
  fingerprint: "approved",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "sessions.read", "history.read"],
  views: [{ id: "history", title: "History", kind: "component", provider: "history" }],
} as PluginInfo;
const selected = { history: { pluginId: plugin.id, viewId: "history" } };
let retained: FrontendHistory;
function Provider({ history }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = history!;
  });
  const Entries = history!.Entries;
  const page = history!.read({ revision: history!.snapshot.revision });
  return (
    <section aria-label="custom history">
      <span>{page.items[0]?.command}</span>
      <Entries />
    </section>
  );
}
const actions = {
  validate: vi.fn(() => true),
  setQuery: vi.fn(),
  refresh: vi.fn(),
  delete: vi.fn(async () => {}),
  execute: vi.fn(async () => {}),
  requestClear: vi.fn(),
};
const props = {
  sessionId: "session",
  hostId: "host",
  title: "Host",
  query: "",
  busy: false,
  error: null,
  entries: [{ id: 1, hostId: "host", command: "pwd", executedAt: 1 }],
  actions,
};
beforeEach(() => {
  vi.clearAllMocks();
  actions.validate.mockReturnValue(true);
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
const choose = () =>
  act(() => useSettings.setState((s) => ({ settings: { ...s.settings, uiProviders: selected } })));
const fixture = () =>
  render(
    <HistorySurface {...props}>
      <input aria-label="native history row" defaultValue="draft" />
    </HistorySurface>,
  );

it("composes the persistent native rows and fences retained contexts after restore or close", () => {
  const view = fixture(),
    row = screen.getByLabelText("native history row");
  fireEvent.change(row, { target: { value: "unsaved" } });
  choose();
  expect(screen.getByRole("region", { name: "custom history" }).contains(row)).toBe(true);
  expect(retained.read({ revision: retained.snapshot.revision }).items[0]!.command).toBe("pwd");
  const old = retained;
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(screen.getByLabelText("native history row")).toBe(row);
  expect(row).toHaveProperty("value", "unsaved");
  expect(() => old.read({ revision: old.snapshot.revision })).toThrow("viewUnavailable");
  choose();
  const closing = retained;
  view.unmount();
  expect(() => closing.refresh()).toThrow("viewUnavailable");
});

it("separates read, write and execution permissions and rechecks a delayed confirmation", async () => {
  choose();
  fixture();
  expect(retained.capabilities).toEqual({ delete: false, clear: false, execute: false });
  await expect(retained.delete(1)).rejects.toThrow("permissionDenied");
  await expect(retained.execute(1)).rejects.toThrow("permissionDenied");
  expect(() => retained.requestClear()).toThrow("permissionDenied");
  act(() =>
    usePlugins.setState({
      items: [{ ...plugin, permissions: [...plugin.permissions, "history.write", "ssh.exec"] }],
    }),
  );
  await retained.delete(1);
  await retained.execute(1);
  retained.requestClear();
  expect(actions.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  expect(actions.execute).toHaveBeenCalledWith(expect.objectContaining({ command: "pwd" }));
  const authorize = actions.requestClear.mock.calls[0]![0] as () => void;
  authorize();
  act(() => usePlugins.setState({ items: [plugin] }));
  expect(authorize).toThrow("permissionDenied");
});

it("blocks stale revisions, immediate source changes, revocation and stopped providers", async () => {
  choose();
  const { rerender } = fixture();
  const old = retained;
  rerender(
    <HistorySurface {...props} query="@command:pwd">
      <input aria-label="native history row" />
    </HistorySurface>,
  );
  expect(() => old.refresh()).toThrow("changed");
  actions.validate.mockReturnValue(false);
  expect(() => retained.refresh()).toThrow("changed");
  actions.validate.mockReturnValue(true);
  const beforeStop = retained;
  act(() => usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] }));
  expect(() => beforeStop.read({ revision: beforeStop.snapshot.revision })).toThrow(
    "viewUnavailable",
  );
  expect(screen.getByLabelText("native history row")).toBeTruthy();
  act(() => usePlugins.setState({ items: [plugin] }));
  const running = retained;
  act(() => usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: true } })));
  expect(() => running.refresh()).toThrow("viewUnavailable");
});

it("requires read declarations, survives lifecycle replay and recovers a failed renderer", () => {
  for (const omitted of plugin.permissions)
    expect(
      uiProviders(
        [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== omitted) }],
        "history",
      ),
    ).toEqual([]);
  choose();
  const view = render(
    <StrictMode>
      <HistorySurface {...props}>
        <input aria-label="native history row" />
      </HistorySurface>
    </StrictMode>,
  );
  expect(screen.getByRole("region", { name: "custom history" })).toBeTruthy();
  const row = screen.getByLabelText("native history row");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(() => {
    throw Error("isolated history crash");
  });
  view.rerender(
    <StrictMode>
      <HistorySurface {...props}>
        <input aria-label="native history row" />
      </HistorySurface>
    </StrictMode>,
  );
  expect(screen.getByRole("alert").textContent).toContain("isolated history crash");
  expect(screen.getByLabelText("native history row")).toBe(row);
});
