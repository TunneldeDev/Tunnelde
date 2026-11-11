import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RecoveryRecord } from "@/features/plugins/recovery/components/RecoveryRecord";
import { useRecoveryPage } from "@/features/plugins/recovery/runtime/useRecoveryPage";
import { RunnerRecoverySection } from "@/features/plugins/recovery/components/RunnerRecoverySection";
import type { RecoveryEntry, RecoverySnapshot } from "@/lib/runners/recovery/contracts";
import i18n from "@/i18n/i18n";
import { deferred } from "../fixtures/plugins";

const mock = vi.hoisted(() => ({
  owners: vi.fn(),
  snapshot: vi.fn(),
  action: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/api/runners/recovery", () => ({ runnerRecoveryApi: mock }));
vi.mock("@/lib/api/ipc", () => ({ api: { openLatestLog: mock.log } }));
const entry: RecoveryEntry = {
  token: "a".repeat(64),
  runnerId: "task",
  hostId: "host",
  directory: "/tasks/one",
  address: "user@server:22",
  serverKey: "SHA256:key",
  stopPending: false,
  launchUncertain: false,
  terminalStatus: null,
  connection: "connected",
  controlChanged: false,
  canReviewDestination: false,
  canHandoff: false,
  canInspect: true,
  canStop: true,
  canForget: false,
};
const snapshot = (pluginId = "old", items = [entry]): RecoverySnapshot => ({
  pluginId,
  entries: items,
  total: items.length,
  nextOffset: null,
});
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  mock.snapshot.mockImplementation(async (id: string) => snapshot(id));
  mock.owners.mockResolvedValue({ ids: ["removed-plugin"], limited: false });
  mock.action.mockResolvedValue({ accepted: true, observation: null });
  mock.log.mockResolvedValue(undefined);
});

it("does not equate a saved record or connected SSH host with a running process", () => {
  render(<RecoveryRecord entry={entry} pending={false} onAction={() => {}} />);
  expect(screen.getByText("Not checked")).toBeTruthy();
  expect(screen.queryByText("Observed: running")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove local record", hidden: true })).toBeNull();
});

it("shows the derived configuration path and a direct native file-browser action", () => {
  const browse = vi.fn();
  render(
    <RecoveryRecord
      entry={{ ...entry, canBrowse: true, configurationPath: "/tasks/one/config-task.json" }}
      pending={false}
      onAction={() => {}}
      onBrowse={browse}
    />,
  );
  fireEvent.click(screen.getByText("task"));
  expect(screen.getByText("/tasks/one/config-task.json")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open remote files" }));
  expect(browse).toHaveBeenCalledOnce();
});

it.each([
  ["reserved", "Not submitted"],
  ["creating", "Directory creation unconfirmed"],
  ["uploading", "Upload incomplete"],
  ["ready", "Deployment ready"],
] as const)(
  "shows deployment %s without claiming a running process or allowing unsafe removal",
  (state, label) => {
    render(
      <RecoveryRecord
        entry={{
          ...entry,
          runnerId: "deployment",
          deploymentState: state,
          canInspect: false,
          canStop: false,
          canForget: state === "reserved",
        }}
        pending={false}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("user@server:22 · one")).toBeTruthy();
    fireEvent.click(screen.getByText("Deployment"));
    expect(screen.queryByRole("button", { name: "Request stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check remote status" })).toBeNull();
    expect(!!screen.queryByRole("button", { name: "Remove local record" })).toBe(
      state === "reserved",
    );
    if (state === "creating" || state === "uploading")
      expect(screen.getByText(/cannot be reused or started/)).toBeTruthy();
  },
);

it.each([
  ["reserved", "Configuration not submitted"],
  ["creating", "Configuration creation unconfirmed"],
  ["writing", "Configuration write incomplete"],
  ["ready", "Configuration saved"],
] as const)("shows private config %s separately from process state", (state, label) => {
  render(
    <RecoveryRecord
      entry={{ ...entry, configurationState: state, terminalStatus: "notFound", canForget: false }}
      pending={false}
      onAction={() => {}}
    />,
  );
  if (state === "creating" || state === "writing")
    expect(screen.getByText(label).closest("summary")).toBeTruthy();
  fireEvent.click(screen.getByText(entry.runnerId));
  expect(screen.getByText(label)).toBeTruthy();
  if (state === "creating" || state === "writing")
    expect(screen.getByText(/does not prove that configuration writes have finished/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove local record" })).toBeNull();
});

it("keeps uncertain launch and saved stop feedback explicit without allowing forget or handoff", () => {
  const onAction = vi.fn();
  render(
    <RecoveryRecord
      entry={{ ...entry, stopPending: true, launchUncertain: true, canStop: false }}
      pending={false}
      onAction={onAction}
    />,
  );
  fireEvent.click(screen.getByText("task"));
  expect(screen.getByText("Stop pending")).toBeTruthy();
  expect(screen.getByText(/launch acknowledgement was lost/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Request stop" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check remote status" }));
  expect(onAction).toHaveBeenCalledWith("inspect");
});

it("loads recovery only when expanded and discovers an uninstalled owner without starting plugins", async () => {
  render(<RunnerRecoverySection />);
  expect(mock.owners).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Remote task recovery"));
  await screen.findByText("removed-plugin");
  await waitFor(() => expect(mock.snapshot).toHaveBeenCalledWith("removed-plugin", 0));
  expect(mock.action).not.toHaveBeenCalled();
});

it("ignores a late old-owner read when the page changes", async () => {
  const old = deferred<RecoverySnapshot>();
  mock.snapshot.mockImplementation((id: string) =>
    id === "old" ? old.promise : Promise.resolve(snapshot(id)),
  );
  const { result, rerender } = renderHook(({ id }) => useRecoveryPage(id, 0), {
    initialProps: { id: "old" },
  });
  rerender({ id: "new" });
  await waitFor(() => expect(result.current.snapshot?.pluginId).toBe("new"));
  await act(async () => old.resolve(snapshot("old")));
  expect(result.current.snapshot?.pluginId).toBe("new");
});

it("does not replay an action or replace a new owner with its late result", async () => {
  const delayed = deferred<{ accepted: boolean; observation: null }>();
  mock.action.mockReturnValue(delayed.promise);
  const { result, rerender } = renderHook(({ id }) => useRecoveryPage(id, 0), {
    initialProps: { id: "old" },
  });
  await waitFor(() => expect(result.current.pending).toBe(false));
  act(() => {
    void result.current.act(entry, "stop");
    void result.current.act(entry, "stop");
  });
  expect(mock.action).toHaveBeenCalledTimes(1);
  expect(mock.action).toHaveBeenCalledWith({ pluginId: "old", token: entry.token, action: "stop" });
  rerender({ id: "new" });
  await waitFor(() => expect(result.current.snapshot?.pluginId).toBe("new"));
  await act(async () => delayed.resolve({ accepted: true, observation: null }));
  expect(result.current.snapshot?.pluginId).toBe("new");
  expect(mock.snapshot.mock.calls.filter(([id]) => id === "old")).toHaveLength(1);
});

it("preserves records on native cancellation and exposes a recoverable action error", async () => {
  mock.action.mockResolvedValueOnce({ accepted: false, observation: null });
  const { result } = renderHook(() => useRecoveryPage("old", 0));
  await waitFor(() => expect(result.current.pending).toBe(false));
  await act(async () => result.current.act(entry, "forget"));
  expect(mock.snapshot).toHaveBeenCalledTimes(1);
  expect(result.current.snapshot?.entries).toHaveLength(1);
  mock.action.mockRejectedValueOnce({
    code: "validation",
    message: "plugin.runners.recordChanged",
  });
  await act(async () => result.current.act(entry, "inspect"));
  expect(result.current.error).toContain("Refresh and review");
  expect(result.current.pending).toBe(false);
});
