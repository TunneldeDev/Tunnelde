import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStats } from "@/lib/api/types";

const { remoteStats } = vi.hoisted(() => ({ remoteStats: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { remoteStats } }));
import { useMonitor } from "@/store/monitor";
import { useMonitorHistory } from "@/store/monitorHistory";
import { subscribeRemoteMonitor } from "@/lib/session/useRemoteMonitor";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

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
  diskReadRate: 1024,
  diskWriteRate: 2048,
  processes: [],
  sampledAt: 1,
};
const releases: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  remoteStats.mockReset().mockResolvedValue(stats);
  useMonitor.getState().forget("s1");
  useSettings.setState({ settings: DEFAULT_SETTINGS });
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
    expect(useMonitorHistory.getState().samples.s1?.[0]).toMatchObject({
      diskRead: 1024,
      diskWrite: 2048,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    releases.pop()?.();
    await vi.advanceTimersByTimeAsync(3000);
    expect(remoteStats).toHaveBeenCalledTimes(3);
    releases.pop()?.();
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(3);
  });

  it("retires late results when the last consumer leaves and never overlaps a replacement", async () => {
    let finish!: (value: RemoteStats) => void;
    remoteStats.mockReturnValueOnce(
      new Promise<RemoteStats>((resolve) => {
        finish = resolve;
      }),
    );
    const old = subscribeRemoteMonitor("s1");
    expect(useMonitor.getState().entries.s1?.loading).toBe(true);
    old();
    expect(useMonitor.getState().entries.s1?.loading).toBe(false);
    releases.push(subscribeRemoteMonitor("s1"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    finish(stats);
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    expect(useMonitorHistory.getState().samples.s1).toHaveLength(1);
  });

  it("does not start the replacement sample if its owner also leaves while waiting", async () => {
    let finish!: (value: RemoteStats) => void;
    remoteStats.mockReturnValueOnce(
      new Promise<RemoteStats>((resolve) => {
        finish = resolve;
      }),
    );
    const first = subscribeRemoteMonitor("s1");
    first();
    const second = subscribeRemoteMonitor("s1");
    second();
    finish(stats);
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledOnce();
    expect(useMonitorHistory.getState().samples.s1).toBeUndefined();
  });

  it("keeps shared sampling alive until every owner releases and preserves existing history", async () => {
    const first = subscribeRemoteMonitor("s1");
    const second = subscribeRemoteMonitor("s1");
    releases.push(second);
    await vi.advanceTimersByTimeAsync(0);
    first();
    first();
    await vi.advanceTimersByTimeAsync(3000);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    releases.pop()?.();
    expect(useMonitorHistory.getState().samples.s1).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(2);
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
    await vi.advanceTimersByTimeAsync(2999);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    finish(stats);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reschedules shared consumers immediately when the configured interval changes", async () => {
    releases.push(subscribeRemoteMonitor("s1"), subscribeRemoteMonitor("s1"));
    await vi.advanceTimersByTimeAsync(0);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monitorIntervalMs: 1000 } });
    await vi.advanceTimersByTimeAsync(999);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monitorIntervalMs: 30000 } });
    await vi.advanceTimersByTimeAsync(29999);
    expect(remoteStats).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteStats).toHaveBeenCalledTimes(3);
  });

  it("applies an interval change after a slow sample without overlapping it", async () => {
    let finish!: (value: RemoteStats) => void;
    remoteStats.mockReturnValueOnce(
      new Promise<RemoteStats>((resolve) => {
        finish = resolve;
      }),
    );
    releases.push(subscribeRemoteMonitor("s1"));
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monitorIntervalMs: 1000 } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    finish(stats);
    await vi.advanceTimersByTimeAsync(999);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteStats).toHaveBeenCalledTimes(2);
  });

  it("keeps interval changes idle while the document is hidden", async () => {
    releases.push(subscribeRemoteMonitor("s1"));
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monitorIntervalMs: 1000 } });
    await vi.advanceTimersByTimeAsync(30000);
    expect(remoteStats).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
