// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStats } from "@/lib/api/types";

const { remoteStats } = vi.hoisted(() => ({ remoteStats: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { remoteStats } }));
import { useMonitor } from "@/store/monitor";
import { useMonitorHistory } from "@/store/monitorHistory";
import { subscribeRemoteMonitor } from "@/lib/session/useRemoteMonitor";

const stats: RemoteStats = {
  cpuPercent: 42,
  cpuCount: 4,
  memoryUsed: 20,
  memoryTotal: 40,
  swapUsed: 0,
  swapTotal: 0,
  diskUsed: 50,
  diskTotal: 100,
  load: [0, 0, 0],
  uptime: 100,
  netRxRate: 2,
  netTxRate: 1,
  processes: [],
  sampledAt: 1,
};
const releases: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  remoteStats.mockReset().mockResolvedValue(stats);
  useMonitor.getState().forget("s1");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  vi.useRealTimers();
});

describe("shared remote monitoring", () => {
  it("coalesces in-flight requests and rejects results after a session was forgotten", async () => {
    let finish!: (stats: RemoteStats) => void;
    remoteStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = useMonitor.getState().sample("s1");
    expect(useMonitor.getState().sample("s1")).toBe(first);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    useMonitor.getState().forget("s1");
    finish(stats);
    await first;
    expect(useMonitor.getState().entries.s1).toBeUndefined();
    expect(useMonitorHistory.getState().samples.s1).toBeUndefined();
  });

  it("shares one loop and history between the panel and page", async () => {
    releases.push(subscribeRemoteMonitor("s1"), subscribeRemoteMonitor("s1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    expect(useMonitorHistory.getState().samples.s1).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    releases.pop()?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(remoteStats).toHaveBeenCalledTimes(3);
    releases.pop()?.();
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(3);
  });

  it("pauses while the window is hidden and samples immediately on return", async () => {
    releases.push(subscribeRemoteMonitor("s1"));
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteStats).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a slow server request", async () => {
    let finish!: (stats: RemoteStats) => void;
    remoteStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    releases.push(subscribeRemoteMonitor("s1"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    finish(stats);
    await vi.advanceTimersByTimeAsync(1999);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    finish(stats);
    await vi.advanceTimersByTimeAsync(0);
  });
});
