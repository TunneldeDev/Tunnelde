import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { remoteProcesses, remoteKill } = vi.hoisted(() => ({
  remoteProcesses: vi.fn(),
  remoteKill: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: { remoteProcesses, remoteKill } }));
import i18n from "@/i18n/i18n";
import { ProcessesDialog } from "@/features/monitor/ProcessesDialog";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useDialogs } from "@/store/dialogs";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { PluginInfo } from "@/lib/api/types";
import type { FrontendProcesses, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
const plugin = {
  id: "process-ui",
  name: "Process UI",
  status: "running",
  fingerprint: "approved",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "sessions.read", "monitor.read", "monitor.write"],
  views: [{ id: "process", title: "Processes", kind: "component", provider: "processes" }],
} as PluginInfo;
let retained: FrontendProcesses;
let omit = false;
function Provider({ processes }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = processes!;
  });
  const Entries = processes!.Entries;
  return <section aria-label="custom processes">{omit ? "Entries omitted" : <Entries />}</section>;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  omit = false;
  remoteProcesses
    .mockReset()
    .mockResolvedValue([
      { pid: 42, startedAtTicks: 100, name: "worker", cpu: 10, cpuTotal: 5, memory: 0, rss: 100 },
    ]);
  remoteKill.mockReset().mockResolvedValue(undefined);
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      uiProviders: { processes: { pluginId: plugin.id, viewId: "process" } },
    },
  });
  useSsh.setState({
    sessions: [
      { id: "s", hostId: "h", title: "Host", address: "host", cols: 80, rows: 24, connectedAt: 0 },
    ],
  });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, restricted: false, grants: { [plugin.id]: plugin.permissions } },
  }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "token").mockReturnValue("token");
});
afterEach(() => {
  cleanup();
  useDialogs.getState().close();
  vi.restoreAllMocks();
});
it("keeps native nodes and sampling through restoration and rejects retained operations", async () => {
  render(<ProcessesDialog sessionId="s" onClose={() => {}} />);
  const row = (await screen.findByText("worker")).closest("tr")!;
  expect(screen.getByRole("region", { name: "custom processes" }).contains(row)).toBe(true);
  const old = retained;
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } })),
  );
  expect(screen.getByText("worker").closest("tr")).toBe(row);
  expect(remoteProcesses).toHaveBeenCalledOnce();
  expect(() => old.refresh()).toThrow("viewUnavailable");
});
it("supports omitted entries, shared query state and read-only access", async () => {
  omit = true;
  usePlugins.setState({
    items: [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== "monitor.write") }],
  });
  render(<ProcessesDialog sessionId="s" onClose={() => {}} />);
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  expect(screen.getByText("Entries omitted")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  expect(retained.capabilities.terminate).toBe(false);
  expect(() =>
    retained.requestTerminate({ revision: retained.snapshot.revision, key: "process:0" }),
  ).toThrow("permissionDenied");
  act(() => retained.setQuery("@name:other"));
  expect(retained.snapshot.total).toBe(0);
  act(() => retained.setQuery("@name:worker"));
  expect(retained.snapshot.total).toBe(1);
});
it("checks current write permission at confirmation and displays the failure in host chrome", async () => {
  render(<ProcessesDialog sessionId="s" onClose={() => {}} />);
  await screen.findByText("worker");
  act(() => retained.requestTerminate({ revision: retained.snapshot.revision, key: "process:0" }));
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("missing native confirmation");
  act(() =>
    usePlugins.setState({
      items: [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== "monitor.write") }],
    }),
  );
  await act(async () => dialog.onConfirm());
  expect(remoteKill).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("permission");
});
it("rejects stale frames and retires confirmations on session disconnect or close", async () => {
  const view = render(<ProcessesDialog sessionId="s" onClose={() => {}} />);
  await screen.findByText("worker");
  const old = retained;
  act(() => retained.select({ revision: retained.snapshot.revision, key: "process:0" }));
  expect(() => old.setQuery("@pid:42")).toThrow("changed");
  act(() => retained.requestTerminate({ revision: retained.snapshot.revision, key: "process:0" }));
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("missing native confirmation");
  act(() => useSsh.setState({ sessions: [] }));
  await act(async () => dialog.onConfirm());
  expect(remoteKill).not.toHaveBeenCalled();
  view.unmount();
  expect(() => retained.refresh()).toThrow("viewUnavailable");
});
it("recovers after duplicate Entries without creating another sampler", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(({ processes }) => {
    const Entries = processes!.Entries;
    return (
      <>
        <Entries />
        <Entries />
      </>
    );
  });
  render(<ProcessesDialog sessionId="s" onClose={() => {}} />);
  await screen.findByText("worker");
  expect(screen.queryByRole("region", { name: "custom processes" })).toBeNull();
  expect(remoteProcesses).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(screen.getAllByText("worker")).toHaveLength(1);
});
