import { expect, it, vi } from "vitest";
import {
  createEventBus,
  createSubscriptionGroup,
  type Dispose,
  type Handler,
} from "@/lib/events/bus";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

it("shares one transport listener and releases it after the final independent subscriber", async () => {
  let receive!: Handler<unknown>;
  const dispose = vi.fn();
  const transport = vi.fn(async (_name, handler) => {
    receive = handler;
    return dispose;
  });
  const bus = createEventBus<{ data: number }>(transport);
  const a = vi.fn(),
    b = vi.fn();
  const [stopA, stopB] = await Promise.all([bus.on("data", a), bus.on("data", b)]);
  expect(transport).toHaveBeenCalledTimes(1);
  receive(1);
  stopA();
  stopA();
  receive(2);
  expect(a.mock.calls).toEqual([[1]]);
  expect(b.mock.calls).toEqual([[1], [2]]);
  expect(dispose).not.toHaveBeenCalled();
  stopB();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(bus.diagnostics()).toEqual([]);
});

it("aborts pending registration and ignores the retired transport after rapid remount", async () => {
  const pending = deferred<Dispose>();
  const cleanupA = vi.fn(),
    cleanupB = vi.fn();
  const handlers: Handler<unknown>[] = [];
  const transport = vi.fn((_name, handler) => {
    handlers.push(handler);
    return handlers.length === 1 ? pending.promise : Promise.resolve(cleanupB);
  });
  const bus = createEventBus<{ data: number }>(transport);
  const a = vi.fn(),
    b = vi.fn();
  const controller = new AbortController();
  const first = bus.on("data", a, controller.signal);
  await Promise.resolve();
  controller.abort();
  const second = await bus.on("data", b);
  pending.resolve(cleanupA);
  await first;
  handlers[0]!(1);
  handlers[1]!(2);
  expect(a).not.toHaveBeenCalled();
  expect(b.mock.calls).toEqual([[2]]);
  expect(cleanupA).toHaveBeenCalledTimes(1);
  expect(cleanupB).not.toHaveBeenCalled();
  second();
});

it("isolates synchronous and asynchronous handler failures without losing later delivery", async () => {
  let receive!: Handler<unknown>;
  const report = vi.fn();
  const bus = createEventBus<{ data: number }>(async (_name, handler) => {
    receive = handler;
    return () => {};
  }, report);
  await bus.on("data", () => {
    throw new Error("sync");
  });
  await bus.on("data", async () => {
    throw new Error("async");
  });
  const good = vi.fn();
  await bus.on("data", good);
  receive(1);
  receive(2);
  await Promise.resolve();
  expect(good.mock.calls).toEqual([[1], [2]]);
  expect(report).toHaveBeenCalledTimes(4);
  bus.dispose();
});

it("removes failed registration and permits a fresh retry without duplicate subscribers", async () => {
  const transport = vi
    .fn()
    .mockRejectedValueOnce(new Error("register failed"))
    .mockResolvedValue(() => {});
  const bus = createEventBus<{ data: number }>(transport);
  await expect(bus.on("data", () => {})).rejects.toThrow("register failed");
  expect(bus.diagnostics()).toEqual([]);
  const stop = await bus.on("data", () => {});
  expect(transport).toHaveBeenCalledTimes(2);
  stop();
});

it("skips pre-aborted subscriptions and does not call a subscriber removed during dispatch", async () => {
  let receive!: Handler<unknown>;
  const transport = vi.fn(async (_name, handler) => {
    receive = handler;
    return () => {};
  });
  const bus = createEventBus<{ data: number }>(transport);
  const controller = new AbortController();
  controller.abort();
  await bus.on("data", vi.fn(), controller.signal);
  expect(transport).not.toHaveBeenCalled();
  let stopB = () => {};
  await bus.on("data", () => stopB());
  const b = vi.fn();
  stopB = await bus.on("data", b);
  receive(1);
  expect(b).not.toHaveBeenCalled();
  bus.dispose();
});

it("registration groups are idempotent, rollback partial failures and can restart", async () => {
  const cleanup = vi.fn();
  const a = vi.fn(async () => cleanup);
  const b = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(() => {});
  const group = createSubscriptionGroup([a, b]);
  const first = group.start();
  expect(group.start()).toBe(first);
  await expect(first).rejects.toThrow("offline");
  expect(cleanup).toHaveBeenCalledTimes(1);
  await group.start();
  expect(a).toHaveBeenCalledTimes(2);
  group.dispose();
  group.dispose();
  expect(cleanup).toHaveBeenCalledTimes(2);
  await group.start();
  expect(a).toHaveBeenCalledTimes(3);
  group.dispose();
});

it("subscribes synchronous transports before returning and keeps stream chunks in order", async () => {
  let receive!: Handler<unknown>;
  const handler = vi.fn();
  const bus = createEventBus<{ stream: string }>(async (_name, onEvent) => {
    receive = onEvent;
    onEvent("first");
    return () => {};
  });
  const registration = bus.on("stream", handler);
  receive("second");
  receive("third");
  await registration;
  expect(handler.mock.calls).toEqual([["first"], ["second"], ["third"]]);
  bus.dispose();
});

it("detaches abort handlers and pending transports on whole-bus disposal", async () => {
  const pending = deferred<Dispose>();
  const cleanup = vi.fn();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const bus = createEventBus<{ data: number }>(() => pending.promise);
  const registration = bus.on("data", vi.fn(), controller.signal);
  bus.dispose();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  pending.resolve(cleanup);
  await registration;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(bus.diagnostics()).toEqual([]);
});

it("releases partial groups immediately on failure and also releases late registrations", async () => {
  const pending = deferred<Dispose>();
  const cleanup = vi.fn(),
    lateCleanup = vi.fn();
  const group = createSubscriptionGroup([
    async () => cleanup,
    async () => {
      throw new Error("failed");
    },
    () => pending.promise,
  ]);
  await expect(group.start()).rejects.toThrow("failed");
  expect(cleanup).toHaveBeenCalledOnce();
  pending.resolve(lateCleanup);
  await Promise.resolve();
  await Promise.resolve();
  expect(lateCleanup).toHaveBeenCalledOnce();
});

it("keeps a restarted group alive when the disposed generation finishes later", async () => {
  const old = deferred<Dispose>();
  const oldCleanup = vi.fn(),
    newCleanup = vi.fn();
  const register = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(newCleanup);
  const group = createSubscriptionGroup([register]);
  const first = group.start();
  await Promise.resolve();
  group.dispose();
  const second = group.start();
  await second;
  old.resolve(oldCleanup);
  await first;
  expect(group.start()).toBe(second);
  expect(oldCleanup).toHaveBeenCalledOnce();
  expect(newCleanup).not.toHaveBeenCalled();
  group.dispose();
  expect(newCleanup).toHaveBeenCalledOnce();
});

it("continues cleanup when a group disposer throws", async () => {
  const report = vi.fn(),
    cleanup = vi.fn();
  const group = createSubscriptionGroup(
    [
      async () => () => {
        throw new Error("dispose failed");
      },
      async () => cleanup,
    ],
    report,
  );
  await group.start();
  group.dispose();
  expect(report).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});
