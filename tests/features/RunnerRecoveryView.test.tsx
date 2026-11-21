import { useState } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { RunnerRecoverySectionView } from "@/features/plugins/recovery/components/RunnerRecoverySectionView";
import { useRecoveryPageModel } from "@/features/plugins/recovery/runtime/useRecoveryPageModel";
import type { RunnerRecoveryServices } from "@/features/plugins/recovery/data/services";
import type { RecoveryEntry, RecoverySnapshot } from "@/lib/runners/recovery/contracts";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
vi.mock("@/lib/api/runners/recovery", () => {
  throw new Error("View imported direct recovery client");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("View imported direct native client");
});
vi.mock("@/features/connect/ConnectDialog", () => {
  throw new Error("View imported credential dialog");
});
vi.mock("@/features/plugins/recovery/runtime/useRecoveryFiles", () => {
  throw new Error("View imported SSH acquisition owner");
});
vi.mock("@tauri-apps/api/core", () => {
  throw new Error("View imported native invoke");
});
const entry: RecoveryEntry = {
  token: "a".repeat(64),
  runnerId: "saved-task",
  hostId: "host",
  directory: "/work",
  address: "user@server",
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
  canBrowse: true,
};
const snapshot = (pluginId = "first", entries = [entry]): RecoverySnapshot => ({
  pluginId,
  entries,
  total: entries.length,
  nextOffset: null,
});
function fixture() {
  const captured = new Map<string, unknown>();
  const browse = vi.fn(async () => {});
  const services: RunnerRecoveryServices = {
    client: {
      owners: vi.fn(async () => ({ ids: ["first", "second"], limited: false })),
      snapshot: vi.fn(async (id) => snapshot(id)),
      action: vi.fn(async () => ({ accepted: true, observation: null })),
    },
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    useFiles: vi.fn(() => ({
      pending: false,
      error: null,
      browse,
      renderConnection: () => <span>Main-owned auth slot</span>,
    })),
    openLog: vi.fn(async () => {}),
  };
  return {
    services,
    captured,
    browse,
    mount: () => render(<RunnerRecoverySectionView services={services} />),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
describe("recovery renderer owner boundaries", () => {
  it("restores owner, page, and record disclosure without replaying a control action", async () => {
    const owner = fixture();
    owner.captured.set("recovery:open", true);
    owner.captured.set("recovery:owner", "second");
    owner.captured.set("recovery:offset", 32);
    const view = owner.mount();
    await screen.findByText("saved-task");
    fireEvent.click(screen.getByText("saved-task"));
    await waitFor(() =>
      expect(owner.captured.get("recovery:second:32:expanded")).toEqual({ [entry.token]: true }),
    );
    view.unmount();
    owner.mount();
    await screen.findByText("saved-task");
    expect(screen.getByText("saved-task").closest("details")).toHaveProperty("open", true);
    expect(owner.services.client.snapshot).toHaveBeenLastCalledWith("second", 32);
    expect(owner.services.client.action).not.toHaveBeenCalled();
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.getByText("Main-owned auth slot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open remote files" }));
    expect(owner.browse).toHaveBeenCalledWith(entry);
  });
  it("prunes observations of obsolete tokens on remount instead of presenting them as live processes", async () => {
    const owner = fixture();
    owner.captured.set("recovery:first:0:observations", {
      obsolete: { token: "obsolete", status: "running", error: null, checkedAt: 1 },
    });
    const { result } = renderHook(() => useRecoveryPageModel("first", 0, owner.services));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.observations).toEqual({});
    expect(owner.services.client.action).not.toHaveBeenCalled();
  });
  it("does not publish an action observation after that record disappears from the new snapshot", async () => {
    const owner = fixture();
    const { result } = renderHook(() => useRecoveryPageModel("first", 0, owner.services));
    await waitFor(() => expect(result.current.pending).toBe(false));
    vi.mocked(owner.services.client.action).mockResolvedValueOnce({
      accepted: true,
      observation: { token: entry.token, status: "running", error: null, checkedAt: 1 },
    });
    vi.mocked(owner.services.client.snapshot).mockResolvedValueOnce(snapshot("first", []));
    await act(async () => result.current.act(entry, "inspect"));
    expect(result.current.snapshot?.entries).toEqual([]);
    expect(result.current.observations).toEqual({});
  });
  it("denies duplicate actions and ignores the old owner's late response", async () => {
    const owner = fixture();
    const delayed = deferred<Awaited<ReturnType<RunnerRecoveryServices["client"]["action"]>>>();
    vi.mocked(owner.services.client.action).mockReturnValueOnce(delayed.promise);
    const { result, rerender } = renderHook(
      ({ id }) => useRecoveryPageModel(id, 0, owner.services),
      { initialProps: { id: "first" } },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    act(() => {
      void result.current.act(entry, "stop");
      void result.current.act(entry, "stop");
    });
    expect(owner.services.client.action).toHaveBeenCalledTimes(1);
    rerender({ id: "second" });
    await waitFor(() => expect(result.current.snapshot?.pluginId).toBe("second"));
    await act(async () => delayed.resolve({ accepted: true, observation: null }));
    expect(owner.services.client.snapshot).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.pluginId).toBe("second");
  });
  it("routes read failures and log navigation through the owner service", async () => {
    const owner = fixture();
    owner.captured.set("recovery:open", true);
    vi.mocked(owner.services.client.owners).mockRejectedValueOnce(
      new Error("Recovery unavailable"),
    );
    owner.mount();
    await screen.findByRole("alert");
    expect(screen.getByText("Recovery unavailable")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Open software log" })),
    );
    expect(owner.services.openLog).toHaveBeenCalledOnce();
    expect(owner.services.client.action).not.toHaveBeenCalled();
  });
});
