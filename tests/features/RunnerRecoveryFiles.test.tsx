import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useRecoveryFiles } from "@/features/plugins/recovery/runtime/useRecoveryFiles";
import type { RecoveryBrowserTarget, RecoveryEntry } from "@/lib/runners/recovery/contracts";
import { deferred } from "../fixtures/plugins";

const mock = vi.hoisted(() => ({
  prepareBrowser: vi.fn(),
  cancelBrowser: vi.fn(),
  probeBrowser: vi.fn(),
  trustBrowser: vi.fn(),
  connectBrowser: vi.fn(),
  openBrowser: vi.fn(),
  disconnect: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  acceptSession: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api/runners/recovery", () => ({ runnerRecoveryApi: mock }));
vi.mock("@/lib/api/ipc", () => ({ api: { sshDisconnect: mock.disconnect } }));
vi.mock("@/store/workspace", () => ({
  useWorkspace: { getState: () => ({ openFilePane: mock.open }) },
}));
vi.mock("@/store/ssh", () => ({
  useSsh: { getState: () => ({ refresh: mock.refresh, acceptSession: mock.acceptSession }) },
}));
vi.mock("@/store/toasts", () => ({ toast: mock.toast }));
vi.mock("@/lib/api/errors", () => ({ translateError: (error: unknown) => String(error) }));
const entry = { token: "record-token" } as RecoveryEntry;
const target = {
  session: { id: "native-session", hostId: "host", address: "user@server:22", title: "Server" },
  directory: "/original/deployment",
  acquired: false,
} as RecoveryBrowserTarget;
beforeEach(() => {
  vi.resetAllMocks();
  mock.prepareBrowser.mockResolvedValue({ host: null, jumpHosts: [] });
  mock.openBrowser.mockResolvedValue(target);
  mock.cancelBrowser.mockResolvedValue(undefined);
  mock.disconnect.mockResolvedValue(undefined);
  mock.refresh.mockResolvedValue(undefined);
});

it("opens the exact native-verified directory without starting a plugin or creating a terminal", async () => {
  const { result } = renderHook(() => useRecoveryFiles("removed-plugin"));
  await act(async () => result.current.browse(entry));
  expect(mock.prepareBrowser).toHaveBeenCalledWith({
    id: expect.any(String),
    pluginId: "removed-plugin",
    token: entry.token,
  });
  expect(mock.open).toHaveBeenCalledWith(
    {
      source: { kind: "remote", sessionId: "native-session" },
      path: "/original/deployment",
      ownerSessionId: "native-session",
      remoteIdentity: { hostId: "host", address: "user@server:22" },
    },
    "Server",
  );
  expect(mock.connectBrowser).not.toHaveBeenCalled();
  expect(mock.acceptSession).toHaveBeenCalledWith(target.session);
  expect(mock.acceptSession.mock.invocationCallOrder[0]).toBeLessThan(
    mock.open.mock.invocationCallOrder[0]!,
  );
  expect(mock.disconnect).not.toHaveBeenCalled();
});

it("offers normal credentials only for the original host and pins native verification to its request", async () => {
  const jumpHosts = [{ id: "jump", host: "captured-server", port: 22 }];
  mock.prepareBrowser.mockResolvedValue({ host: { id: "original" }, jumpHosts });
  const { result } = renderHook(() => useRecoveryFiles("removed-plugin"));
  await act(async () => result.current.browse(entry));
  const id = mock.prepareBrowser.mock.calls[0]![0].id;
  expect(result.current.connection?.host.id).toBe("original");
  expect(result.current.verification!.jumpHosts).toEqual(jumpHosts);
  expect(mock.open).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.verification!.probe({});
  });
  expect(mock.probeBrowser).toHaveBeenCalledWith(id, {});
  await act(async () => {
    await result.current.verification!.trust("key", {}, "original");
  });
  expect(mock.trustBrowser).toHaveBeenCalledWith(id, "key", {}, "original");
  await act(async () => {
    await result.current.connected();
  });
  expect(mock.openBrowser).toHaveBeenCalledWith(id);
  expect(mock.open).toHaveBeenCalledTimes(1);
});

it("cancels a late plan after the page closes and never starts its connection", async () => {
  const plan = deferred<{ host: null }>();
  mock.prepareBrowser.mockReturnValue(plan.promise);
  const { result, unmount } = renderHook(() => useRecoveryFiles("old"));
  act(() => {
    void result.current.browse(entry);
  });
  const id = mock.prepareBrowser.mock.calls[0]![0].id;
  unmount();
  await act(async () => plan.resolve({ host: null }));
  expect(mock.cancelBrowser).toHaveBeenCalledWith(id);
  expect(mock.openBrowser).not.toHaveBeenCalled();
});

it.each([false, true])(
  "late acceptance disposes only a newly acquired connection (acquired=%s)",
  async (acquired) => {
    const opened = deferred<RecoveryBrowserTarget>();
    mock.openBrowser.mockReturnValue(opened.promise);
    const { result, unmount } = renderHook(() => useRecoveryFiles("old"));
    act(() => {
      void result.current.browse(entry);
    });
    await waitFor(() => expect(mock.openBrowser).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => opened.resolve({ ...target, acquired }));
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.disconnect).toHaveBeenCalledTimes(acquired ? 1 : 0);
  },
);

it("switching owners cancels the pending native request without navigating its late response", async () => {
  const plan = deferred<{ host: null }>();
  mock.prepareBrowser.mockReturnValueOnce(plan.promise);
  const { result, rerender } = renderHook(({ owner }) => useRecoveryFiles(owner), {
    initialProps: { owner: "old" },
  });
  act(() => {
    void result.current.browse(entry);
  });
  const id = mock.prepareBrowser.mock.calls[0]![0].id;
  rerender({ owner: "new" });
  await act(async () => plan.resolve({ host: null }));
  expect(mock.cancelBrowser).toHaveBeenCalledWith(id);
  expect(mock.openBrowser).not.toHaveBeenCalled();
  await act(async () => result.current.browse(entry));
  expect(mock.prepareBrowser.mock.calls[1]![0].pluginId).toBe("new");
});

it("does not duplicate an acquisition and shows a record-change error with retry available", async () => {
  const plan = deferred<{ host: null }>();
  mock.prepareBrowser.mockReturnValueOnce(plan.promise);
  const { result } = renderHook(() => useRecoveryFiles("owner"));
  act(() => {
    void result.current.browse(entry);
    void result.current.browse(entry);
  });
  expect(mock.prepareBrowser).toHaveBeenCalledTimes(1);
  await act(async () => plan.reject(new Error("record changed")));
  expect(result.current.error).toContain("record changed");
  expect(result.current.pending).toBe(false);
  await act(async () => result.current.browse(entry));
  expect(mock.prepareBrowser).toHaveBeenCalledTimes(2);
});
