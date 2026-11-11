import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { remoteStats } = vi.hoisted(() => ({ remoteStats: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: { remoteStats } }));
import "@/i18n/i18n";
import { RemotePanel } from "@/components/layout/RemotePanel";
import { MonitorPage } from "@/features/monitor/MonitorPage";
import { useMonitor } from "@/store/monitor";
import { useMonitorHistory } from "@/store/monitorHistory";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { uiProviders } from "@/lib/extensions/providers";
import type { PluginInfo, SshSession } from "@/lib/api/types";
import type { FrontendMonitor, FrontendViewProps } from "@/lib/extensions/uiSdkContract";

const session = {
  id: "monitor-session",
  hostId: "host",
  title: "Host",
  address: "qa@host",
} as SshSession;
const plugin = {
  id: "monitor-ui",
  name: "Monitor UI",
  status: "running",
  fingerprint: "approved",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "sessions.read", "monitor.read"],
  views: [{ id: "monitor", title: "Monitoring", kind: "component", provider: "monitor" }],
} as PluginInfo;
const selection = { monitor: { pluginId: plugin.id, viewId: "monitor" } };
let retained: FrontendMonitor;
let showCharts = true;
function Provider({ monitor }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = monitor!;
  });
  const Charts = monitor!.Charts;
  return (
    <section aria-label="custom monitor">{showCharts ? <Charts /> : "Charts omitted"}</section>
  );
}
beforeEach(() => {
  mockCommittedViewScopes();
  showCharts = true;
  remoteStats.mockReset().mockResolvedValue({
    cpuPercent: 42,
    cpuCount: 4,
    swapUsed: 0,
    swapTotal: 0,
    uptime: 1000,
    load: [0.1, 0.2, 0.3],
    processes: [],
    memoryUsed: 1,
    memoryTotal: 2,
    diskUsed: 1,
    diskTotal: 4,
    sampledAt: 1,
    netRxRate: 0,
    netTxRate: 1,
    diskReadRate: null,
    diskWriteRate: 2,
  });
  useMonitor.getState().forget(session.id);
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: selection } });
  useSsh.setState({ sessions: [session] });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, restricted: false, grants: { [plugin.id]: plugin.permissions } },
  }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "token").mockReturnValue("token");
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("retains the same native chart nodes and sampler through provider restoration", async () => {
  render(<MonitorPage sessionId={session.id} />);
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  const chart = screen.getByRole("slider", { name: "CPU history" });
  expect(screen.getByRole("region", { name: "custom monitor" }).contains(chart)).toBe(true);
  const old = retained;
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } })),
  );
  expect(screen.getByRole("slider", { name: "CPU history" })).toBe(chart);
  expect(remoteStats).toHaveBeenCalledOnce();
  expect(() => old.refresh()).toThrow("viewUnavailable");
});

it("samples without Charts, rejects retained refreshes after new data and pauses inactive pages", async () => {
  showCharts = false;
  const view = render(<MonitorPage sessionId={session.id} />);
  await screen.findByText("Charts omitted");
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  expect(screen.queryByRole("slider")).toBeNull();
  const old = retained;
  act(() => retained.refresh());
  expect(() => old.refresh()).toThrow("changed");
  await waitFor(() => expect(retained.snapshot.total).toBe(2));
  expect(useMonitorHistory.getState().samples[session.id]).toHaveLength(2);
  view.rerender(<MonitorPage sessionId={session.id} active={false} />);
  expect(retained.snapshot.sampling).toBe(false);
  expect(() => retained.refresh()).toThrow("inactive");
});

it("reauthorizes token, selection and read permissions without requiring write permissions", async () => {
  const view = render(
    <StrictMode>
      <MonitorPage sessionId={session.id} />
    </StrictMode>,
  );
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  // StrictMode retires its first effect's result, then samples the new owner serially.
  expect(remoteStats).toHaveBeenCalledTimes(2);
  expect(retained.read({ revision: retained.snapshot.revision }).items[0]!.cpu).toBe(42);
  const old = retained;
  vi.mocked(frontendRuntime.token).mockReturnValue("replacement");
  expect(() => old.read({ revision: old.snapshot.revision })).toThrow("viewUnavailable");
  view.unmount();
  expect(() => old.refresh()).toThrow("viewUnavailable");
  for (const permission of plugin.permissions)
    expect(
      uiProviders(
        [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== permission) }],
        "monitor",
      ),
    ).toEqual([]);
});

it("recovers native charts after duplicate mounts without dropping history or starting another sampler", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(({ monitor }) => {
    const Charts = monitor!.Charts;
    return (
      <>
        <Charts />
        <Charts />
      </>
    );
  });
  render(<MonitorPage sessionId={session.id} />);
  await screen.findByRole("alert");
  expect(screen.getAllByRole("slider")).toHaveLength(4);
  await waitFor(() => expect(useMonitorHistory.getState().samples[session.id]).toHaveLength(1));
  expect(remoteStats).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
});

it("shares one sampler between compact panel and page, keeping native process actions outside replacement", async () => {
  const panel = render(<RemotePanel sessionId={session.id} width={320} onHide={vi.fn()} />);
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  expect(retained.snapshot.presentation).toBe("panel");
  expect(retained.snapshot.latest?.cpuCount).toBe(4);
  expect(screen.getByRole("button", { name: "Processes" })).toBeTruthy();
  const panelApi = retained;
  const page = render(<MonitorPage sessionId={session.id} />);
  await waitFor(() => expect(retained.snapshot.presentation).toBe("page"));
  expect(remoteStats).toHaveBeenCalledOnce();
  const chart = within(page.container).getByRole("slider", { name: "CPU history" });
  page.unmount();
  act(() => expect(() => panelApi.refresh()).not.toThrow());
  await waitFor(() => expect(useMonitorHistory.getState().samples[session.id]).toHaveLength(2));
  expect(chart.isConnected).toBe(false);
  panel.rerender(<RemotePanel sessionId={session.id} width={320} onHide={vi.fn()} hidden />);
  expect(retained.snapshot.sampling).toBe(false);
  expect(() => retained.refresh()).toThrow("inactive");
  expect(remoteStats).toHaveBeenCalledTimes(2);
});

it("retires handles when a mounted monitor changes connection, even for the same provider", async () => {
  const view = render(<MonitorPage sessionId={session.id} />);
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  const old = retained;
  const other = { ...session, id: "other-session", hostId: "other-host", title: "Other" };
  act(() => useSsh.setState({ sessions: [session, other] }));
  view.rerender(<MonitorPage sessionId={other.id} />);
  await waitFor(() => expect(retained.snapshot.sessionId).toBe(other.id));
  expect(() => old.read({ revision: old.snapshot.revision })).toThrow("viewUnavailable");
  expect(() => old.refresh()).toThrow("viewUnavailable");
  const current = retained;
  act(() => usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] }));
  expect(() => current.read({ revision: current.snapshot.revision })).toThrow("viewUnavailable");
  view.unmount();
  useMonitor.getState().forget(other.id);
});
