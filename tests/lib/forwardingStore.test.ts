import { expect, it, vi } from "vitest";
import { createForwardingStore, type ForwardInfo } from "@/features/forwarding/data/store";

const row = (name: string): ForwardInfo => ({
  id: "rule",
  hostId: "host",
  name,
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  targetHost: "localhost",
  targetPort: 80,
  active: false,
  sessionId: null,
  revision: "revision-1",
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("shares one read across surfaces and coalesces changes during a pending read", async () => {
  const first = deferred<ForwardInfo[]>(),
    second = deferred<ForwardInfo[]>();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let changed!: () => void;
  const detach = vi.fn(),
    observe = vi.fn((refresh) => {
      changed = refresh;
      return detach;
    });
  const store = createForwardingStore(load, observe);
  const a = store.subscribe(vi.fn()),
    b = store.subscribe(vi.fn());
  expect(load).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) changed();
  first.resolve([row("old")]);
  await settle();
  expect(store.getSnapshot().entries).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
  second.resolve([row("current")]);
  await settle();
  expect(store.getSnapshot().entries?.[0]?.name).toBe("current");
  a();
  a();
  expect(detach).not.toHaveBeenCalled();
  b();
  expect(detach).toHaveBeenCalledOnce();
  expect(store.getSnapshot().entries).toBeNull();
});

it("publishes committed saves without waiting for stale reads and releases the updated lifetime", async () => {
  const old = deferred<ForwardInfo[]>(),
    fresh = deferred<ForwardInfo[]>();
  const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const detach = vi.fn();
  const store = createForwardingStore(load, () => detach);
  const stop = store.subscribe(vi.fn());
  store.saved(row("saved"));
  expect(store.getSnapshot().entries?.[0]?.name).toBe("saved");
  expect(load).toHaveBeenCalledTimes(2);
  old.resolve([]);
  await settle();
  expect(store.getSnapshot().entries?.[0]?.name).toBe("saved");
  stop();
  fresh.resolve([row("late")]);
  await settle();
  expect(store.getSnapshot().entries).toBeNull();
  expect(detach).toHaveBeenCalledOnce();
  store.refresh();
  expect(load).toHaveBeenCalledTimes(2);
});

it("keeps committed rows on read failure and recovers through refresh", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce([row("saved")])
    .mockRejectedValueOnce(new Error("read unavailable"))
    .mockResolvedValueOnce([row("recovered")]);
  const store = createForwardingStore(load, () => () => {});
  const stop = store.subscribe(vi.fn());
  await settle();
  store.refresh();
  await settle();
  expect(store.getSnapshot().entries?.[0]?.name).toBe("saved");
  expect(store.getSnapshot().error).toMatchObject({ message: "read unavailable" });
  store.refresh();
  await settle();
  expect(store.getSnapshot().entries?.[0]?.name).toBe("recovered");
  expect(store.getSnapshot().error).toBeNull();
  stop();
});
