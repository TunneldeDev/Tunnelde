import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteProcess } from "@/lib/api/types";
const { remoteProcesses } = vi.hoisted(() => ({ remoteProcesses: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { remoteProcesses } }));
import { useProcesses } from "@/features/monitor/useProcesses";
import { useSettings } from "@/store/settings";

const item = (name = "worker"): RemoteProcess => ({
  pid: 42,
  name,
  cpu: 291,
  cpuTotal: 36.375,
  memory: 1,
  rss: 1024,
});
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const visibility = (state: string) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  remoteProcesses.mockReset().mockResolvedValue([item()]);
  visibility("visible");
  useSettings.setState((old) => ({
    settings: { ...old.settings, monitorIntervalMs: 1000, lightweightMode: false },
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  visibility("visible");
});

describe("process sampling lifecycle", () => {
  it("refreshes after completion without overlapping slow requests and retains rows on failure", async () => {
    let resolve!: (items: RemoteProcess[]) => void;
    const hook = renderHook(() => useProcesses("one"));
    await flush();
    expect(hook.result.current.items?.[0]?.name).toBe("worker");
    remoteProcesses.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await flush(1000);
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    await flush(10000);
    act(() => hook.result.current.refresh());
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    expect(hook.result.current.items?.[0]?.name).toBe("worker");
    await act(async () => resolve([item("new worker")]));
    await flush(999);
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    remoteProcesses.mockRejectedValueOnce(new Error("Disconnected"));
    await flush(1);
    expect(remoteProcesses).toHaveBeenCalledTimes(3);
    expect(hook.result.current.items?.[0]?.name).toBe("new worker");
    expect(hook.result.current.error).toBe("Disconnected");
    await flush(1000);
    expect(hook.result.current.error).toBeNull();
  });

  it("pauses while hidden, supports pause/manual refresh/resume, and stops after unmount", async () => {
    const hook = renderHook(() => useProcesses("one"));
    await flush();
    act(() => visibility("hidden"));
    await flush(5000);
    expect(remoteProcesses).toHaveBeenCalledTimes(1);
    act(() => visibility("visible"));
    await flush();
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    act(() => hook.result.current.togglePaused());
    await flush(5000);
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    act(() => hook.result.current.refresh());
    await flush();
    expect(remoteProcesses).toHaveBeenCalledTimes(3);
    await flush(5000);
    expect(remoteProcesses).toHaveBeenCalledTimes(3);
    act(() => hook.result.current.togglePaused());
    await flush();
    expect(remoteProcesses).toHaveBeenCalledTimes(4);
    hook.unmount();
    await flush(5000);
    expect(remoteProcesses).toHaveBeenCalledTimes(4);
  });

  it("applies monitor interval and lightweight settings without overlapping a pending sample", async () => {
    const hook = renderHook(() => useProcesses("one"));
    await flush();
    act(() =>
      useSettings.setState((old) => ({ settings: { ...old.settings, lightweightMode: true } })),
    );
    await flush(4999);
    expect(remoteProcesses).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    act(() =>
      useSettings.setState((old) => ({ settings: { ...old.settings, monitorIntervalMs: 10000 } })),
    );
    await flush(9999);
    expect(remoteProcesses).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(remoteProcesses).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("ignores a previous server's late failure", async () => {
    let reject!: (error: Error) => void;
    remoteProcesses.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const hook = renderHook(({ id }) => useProcesses(id), { initialProps: { id: "old" } });
    await flush();
    hook.rerender({ id: "new" });
    await flush();
    await act(async () => reject(new Error("Old server failed")));
    expect(hook.result.current.items?.[0]?.name).toBe("worker");
    expect(hook.result.current.error).toBeNull();
  });
});
