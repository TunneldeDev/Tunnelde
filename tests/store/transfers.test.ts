import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import { transferApi } from "@/lib/api/transfers";
import * as ipc from "@/lib/api/ipc";
import { useTransfers } from "@/store/transfers";
import type { TransferEvent } from "@/lib/api/types";

const running: TransferEvent = {
  id: "transfer",
  direction: "transfer",
  name: "file.txt",
  transferred: 0,
  total: 100,
  status: "running",
  error: null,
};

beforeEach(() => useTransfers.setState({ items: [] }));

describe("transfer cancellation", () => {
  it("waits for the backend result and retains cancellation during progress updates", () => {
    vi.spyOn(api, "transferCancel").mockResolvedValue(undefined);
    const store = useTransfers.getState();
    store.apply(running);
    store.cancel(running.id);
    store.cancel(running.id);
    expect(api.transferCancel).toHaveBeenCalledTimes(1);
    expect(useTransfers.getState().items[0]).toMatchObject({ status: "running", cancelling: true });
    store.apply({ ...running, transferred: 50 });
    expect(useTransfers.getState().items[0]?.cancelling).toBe(true);
    store.apply({ ...running, status: "cancelled", transferred: 50 });
    expect(useTransfers.getState().items[0]).toMatchObject({ status: "cancelled" });
    store.apply({ ...running, transferred: 20 });
    expect(useTransfers.getState().items[0]?.status).toBe("cancelled");
  });

  it("allows retry when the cancellation request fails", async () => {
    vi.spyOn(api, "transferCancel").mockRejectedValue(new Error("Could not cancel"));
    useTransfers.getState().apply(running);
    await act(async () => useTransfers.getState().cancel(running.id));
    expect(useTransfers.getState().items[0]).toMatchObject({
      status: "running",
      cancelling: false,
    });
  });
});

describe("durable transfer controls", () => {
  it("does not resume cancelled transfers after their temporary data was discarded", () => {
    const resume = vi.spyOn(transferApi, "resume").mockResolvedValue(undefined);
    useTransfers.setState({
      items: [{ ...running, status: "cancelled", durable: true, updatedAt: 1 }],
    });
    useTransfers.getState().resume(running.id);
    expect(resume).not.toHaveBeenCalled();
    expect(useTransfers.getState().items[0]?.status).toBe("cancelled");
  });

  it("prevents duplicate pause requests and keeps pending pause through progress events", async () => {
    vi.spyOn(transferApi, "pause").mockResolvedValue(undefined);
    useTransfers.setState({ items: [{ ...running, durable: true, updatedAt: 1 }] });
    const store = useTransfers.getState();
    store.pause(running.id);
    store.pause(running.id);
    store.apply({ ...running, transferred: 25 });
    expect(useTransfers.getState().items[0]?.pausing).toBe(true);
    expect(transferApi.pause).toHaveBeenCalledTimes(1);
    store.apply({ ...running, status: "paused", transferred: 25 });
    expect(useTransfers.getState().items[0]?.pausing).toBeUndefined();
  });

  it("keeps the row until cleanup completes and prevents resume during cleanup", async () => {
    let finish!: () => void;
    vi.spyOn(transferApi, "clear").mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const resume = vi.spyOn(transferApi, "resume").mockResolvedValue(undefined);
    useTransfers.setState({
      items: [{ ...running, status: "cancelled", durable: true, updatedAt: 1 }],
    });
    const store = useTransfers.getState();
    store.clear(running.id);
    store.clear(running.id);
    store.resume(running.id);
    expect(useTransfers.getState().items[0]?.clearing).toBe(true);
    expect(transferApi.clear).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(useTransfers.getState().items).toHaveLength(0);
  });

  it("retains a failed cleanup so a disconnected host can be reconnected and retried", async () => {
    vi.spyOn(transferApi, "clear").mockRejectedValue(new Error("reconnectRequired"));
    useTransfers.setState({
      items: [{ ...running, status: "paused", durable: true, updatedAt: 1 }],
    });
    await act(async () => useTransfers.getState().clear(running.id));
    expect(useTransfers.getState().items[0]).toMatchObject({ status: "paused", clearing: false });
  });

  it("keeps deferred cleanup visible and prevents accidentally resuming discarded data", async () => {
    const pending = {
      ...running,
      status: "cleanupPending" as const,
      updatedAt: 2,
      fromHostId: null,
      toHostId: "host",
      error: "sftp.reconnectRequired",
    };
    vi.spyOn(transferApi, "clear").mockResolvedValue(pending);
    const resume = vi.spyOn(transferApi, "resume").mockResolvedValue(undefined);
    useTransfers.setState({
      items: [{ ...running, status: "failed", durable: true, updatedAt: 1 }],
    });
    await act(async () => useTransfers.getState().clear(running.id));
    expect(useTransfers.getState().items[0]).toMatchObject({
      status: "cleanupPending",
      clearing: false,
    });
    useTransfers.getState().resume(running.id);
    expect(resume).not.toHaveBeenCalled();
    vi.mocked(transferApi.clear).mockResolvedValue(null);
    await act(async () => useTransfers.getState().clear(running.id));
    expect(useTransfers.getState().items).toHaveLength(0);
  });

  it("reconciles tasks removed by native background cleanup", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    vi.spyOn(transferApi, "list").mockResolvedValue([]);
    useTransfers.setState({
      items: [
        { ...running, status: "cleanupPending", durable: true, updatedAt: 1 },
        { ...running, id: "plugin", updatedAt: 1 },
      ],
    });
    await useTransfers.getState().hydrate();
    expect(useTransfers.getState().items.map((item) => item.id)).toEqual(["plugin"]);
  });

  it("loads recovery paths even when the cancellation event is newer than the journal", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const backupRecovery = { backup: "/remote/.backup", destination: "/remote/file" };
    vi.spyOn(transferApi, "list").mockResolvedValue([
      {
        ...running,
        status: "cleanupPending",
        updatedAt: 1,
        fromHostId: null,
        toHostId: "host",
        backupRecovery,
      },
    ]);
    useTransfers.setState({
      items: [{ ...running, durable: true, updatedAt: 1 }],
    });
    useTransfers.getState().apply({
      ...running,
      status: "cleanupPending",
      error: "sftp.backupRecoveryRequired",
    });
    await useTransfers.getState().hydrate();
    expect(useTransfers.getState().items[0]).toMatchObject({
      status: "cleanupPending",
      error: "sftp.backupRecoveryRequired",
      backupRecovery,
    });
  });

  it("ignores old snapshots that finish after a newer deletion snapshot", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    let finish!: (rows: Awaited<ReturnType<typeof transferApi.list>>) => void;
    const list = vi.spyOn(transferApi, "list").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    useTransfers.setState({ items: [{ ...running, durable: true, updatedAt: 1 }] });
    const older = useTransfers.getState().hydrate();
    list.mockResolvedValue([]);
    await useTransfers.getState().hydrate();
    finish([{ ...running, updatedAt: 1, fromHostId: null, toHostId: "host" }]);
    await older;
    expect(useTransfers.getState().items).toHaveLength(0);
  });

  it("resumes before progress arrives and never overwrites a fast completion", async () => {
    let finish!: () => void;
    vi.spyOn(transferApi, "resume").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    useTransfers.setState({
      items: [{ ...running, status: "paused", durable: true, updatedAt: 1 }],
    });
    useTransfers.getState().resume(running.id);
    expect(useTransfers.getState().items[0]?.status).toBe("running");
    useTransfers.getState().apply({ ...running, status: "done", transferred: 100 });
    await act(async () => finish());
    expect(useTransfers.getState().items[0]?.status).toBe("done");
  });
  it("retains paused jobs when many ordinary transfers finish", () => {
    useTransfers.setState({
      items: [{ ...running, status: "paused", durable: true, updatedAt: 1 }],
    });
    for (let n = 0; n < 12; n++)
      useTransfers.getState().apply({ ...running, id: `finished-${n}`, status: "done" });
    expect(
      useTransfers.getState().items.some((x) => x.id === running.id && x.status === "paused"),
    ).toBe(true);
    expect(useTransfers.getState().items).toHaveLength(7);
  });
});
