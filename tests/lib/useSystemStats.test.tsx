// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemStats } from "@/lib/api/types";

const { apiMock } = vi.hoisted(() => ({ apiMock: { systemStats: vi.fn() } }));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock, isTauri: () => true }));

import "@/i18n/i18n";
import { SystemPanel } from "@/components/layout/SystemPanel";
import { useSystemStats } from "@/lib/session/useSystemStats";

const stats: SystemStats = {
  cpuUsage: 21,
  memoryUsed: 100,
  memoryTotal: 200,
  swapUsed: 0,
  swapTotal: 0,
  diskUsed: 0,
  diskTotal: 0,
  uptime: 600,
  loadAverage: [0, 0, 0],
  processCount: 12,
  appMemory: 10,
  appProcesses: 2,
  disks: [],
  sampledAt: 0,
};

let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.systemStats.mockReset().mockResolvedValue(stats);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function changeVisibility(next: DocumentVisibilityState) {
  visibility = next;
  fireEvent(document, new Event("visibilitychange"));
}

async function flushRequests() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("local system stats sampling", () => {
  it("stops a collapsed SystemPanel and refreshes immediately when reopened", async () => {
    const { rerender } = render(<SystemPanel width={280} hidden onHide={() => {}} />);
    expect(apiMock.systemStats).not.toHaveBeenCalled();
    rerender(<SystemPanel width={280} hidden={false} onHide={() => {}} />);
    await flushRequests();
    expect(apiMock.systemStats).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(2);
    rerender(<SystemPanel width={280} hidden onHide={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(2);
    rerender(<SystemPanel width={280} hidden={false} onHide={() => {}} />);
    await flushRequests();
    expect(apiMock.systemStats).toHaveBeenCalledTimes(3);
  });

  it("does not overlap a slow IPC request across disable and re-enable", async () => {
    let complete!: (value: SystemStats) => void;
    apiMock.systemStats.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ enabled }) => useSystemStats(1000, enabled), {
      initialProps: { enabled: true },
    });
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(apiMock.systemStats).toHaveBeenCalledTimes(1);
    await act(async () => complete(stats));
    expect(result.current).toEqual(stats);
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(2);
  });

  it("has no background timer and samples immediately after visibility returns", async () => {
    visibility = "hidden";
    const { unmount } = renderHook(() => useSystemStats(3000));
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(apiMock.systemStats).not.toHaveBeenCalled();
    changeVisibility("visible");
    await flushRequests();
    expect(apiMock.systemStats).toHaveBeenCalledTimes(1);
    changeVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(1);
    changeVisibility("visible");
    await flushRequests();
    expect(apiMock.systemStats).toHaveBeenCalledTimes(2);
    unmount();
    changeVisibility("hidden");
    changeVisibility("visible");
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(apiMock.systemStats).toHaveBeenCalledTimes(2);
  });

  it("discards a result delivered while the window is hidden", async () => {
    let complete!: (value: SystemStats) => void;
    apiMock.systemStats.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result } = renderHook(() => useSystemStats(3000));
    changeVisibility("hidden");
    await act(async () => complete(stats));
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    changeVisibility("visible");
    await flushRequests();
    expect(apiMock.systemStats).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(stats);
  });
});
