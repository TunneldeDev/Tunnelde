import { expect, it, vi } from "vitest";
import { createMonitorContext } from "@/lib/extensions/monitor/context";
import { guardMonitorProvider } from "@/lib/extensions/monitor/provider";

const point = (at: number) => ({
  at,
  cpu: 30,
  memory: 40,
  disk: 50,
  rx: 0,
  tx: 20,
  diskRead: null,
  diskWrite: 10,
});
const snapshot = {
  sessionId: "session",
  hostId: "host",
  title: "Host",
  revision: "frame",
  presentation: "page" as const,
  latest: null,
  total: 0,
  sampling: true,
  busy: false,
  error: null,
};

it("projects the latest 240 immutable samples in bounded pages without leaking internal fields", () => {
  const samples = Array.from({ length: 300 }, (_, index) => ({
    ...point(index),
    privateState: "secret",
  }));
  const context = createMonitorContext(snapshot, samples, () => true, vi.fn());
  samples[60]!.cpu = 999;
  const first = context.read({ revision: "frame" });
  expect(first.items).toHaveLength(128);
  expect(first.total).toBe(240);
  expect(first.items[0]).toEqual(point(60));
  expect(Object.isFrozen(first.items[0])).toBe(true);
  expect(Object.isFrozen(first.items)).toBe(true);
  expect(Object.isFrozen(context.snapshot)).toBe(true);
  const last = context.read({ revision: "frame", offset: first.nextOffset! });
  expect(last.items).toHaveLength(112);
  expect(last.nextOffset).toBeNull();
});

it("preserves unknown values and sanitizes nonfinite or negative metrics without inventing zeros", () => {
  const context = createMonitorContext(
    snapshot,
    [{ ...point(1), cpu: NaN, memory: -1, rx: Infinity }],
    () => true,
    vi.fn(),
  );
  expect(context.read({ revision: "frame" }).items[0]).toEqual({
    ...point(1),
    cpu: null,
    memory: null,
    rx: null,
  });
});

it("rejects malformed and stale pages, stale refreshes and hidden sampling, allowing recovery from errors", () => {
  let live = true;
  const refresh = vi.fn();
  const context = createMonitorContext(
    { ...snapshot, error: "previous failure" },
    [point(1)],
    () => live,
    refresh,
  );
  for (const offset of [-1, 0.5, NaN, Infinity, 2])
    expect(() => context.read({ revision: "frame", offset })).toThrow("invalid");
  expect(() => context.read(null!)).toThrow("invalid");
  expect(() => context.read({ revision: "old" })).toThrow("changed");
  context.refresh();
  expect(refresh).toHaveBeenCalledOnce();
  live = false;
  expect(() => context.refresh()).toThrow("changed");
  expect(context.read({ revision: "frame" }).items).toHaveLength(1);
  const hidden = createMonitorContext({ ...snapshot, sampling: false }, [], () => true, refresh);
  expect(() => hidden.refresh()).toThrow("inactive");
});

it("reauthorizes both reads and refreshes after runtime or permission revocation", () => {
  const access = vi.fn();
  const context = createMonitorContext(snapshot, [point(1)], () => true, vi.fn());
  const api = guardMonitorProvider({ ...context, Charts: () => null }, access);
  api.read({ revision: "frame" });
  expect(access).toHaveBeenCalledWith(false);
  api.refresh();
  expect(access).toHaveBeenLastCalledWith();
  access.mockImplementation(() => {
    throw new Error("revoked");
  });
  expect(() => api.read({ revision: "frame" })).toThrow("revoked");
  expect(() => api.refresh()).toThrow("revoked");
});

it("projects absolute resource values independently and freezes nested load values", () => {
  const latest = {
    cpuCount: 4,
    memoryUsed: 1024,
    memoryTotal: 2048,
    swapUsed: 0,
    swapTotal: 0,
    diskUsed: 10,
    diskTotal: 100,
    uptime: 123,
    load: [0.1, NaN, -1] as [number, number, number],
    internalProcessCache: "private",
  };
  const source = { ...snapshot, latest, privateSession: "private" };
  const context = createMonitorContext(source, [], () => true, vi.fn());
  latest.load[0] = 999;
  latest.memoryUsed = 999;
  expect(context.snapshot.latest).toEqual({
    cpuCount: 4,
    memoryUsed: 1024,
    memoryTotal: 2048,
    swapUsed: 0,
    swapTotal: 0,
    diskUsed: 10,
    diskTotal: 100,
    uptime: 123,
    load: [0.1, null, null],
  });
  expect(Object.isFrozen(context.snapshot.latest)).toBe(true);
  expect(Object.isFrozen(context.snapshot.latest!.load)).toBe(true);
  expect(context.snapshot).not.toHaveProperty("privateSession");
});
