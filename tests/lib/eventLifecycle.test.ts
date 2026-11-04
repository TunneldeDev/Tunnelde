import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventLifecycle } from "@/lib/events/lifecycle";
import type { Dispose } from "@/lib/events/bus";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("retries only the unavailable subscription and reads a snapshot once recovered", async () => {
  const healthy = vi.fn(async () => vi.fn());
  const recover = vi.fn(async () => {}),
    report = vi.fn();
  const failed = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(vi.fn());
  const lifecycle = createEventLifecycle(
    [{ register: healthy }, { register: failed, recover }],
    report,
  );
  const started = lifecycle.start();
  expect(lifecycle.start()).toBe(started);
  await started;
  expect(report).toHaveBeenCalledOnce();
  expect(recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(healthy).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledTimes(2);
  expect(recover).toHaveBeenCalledOnce();
  lifecycle.dispose();
});

it("backs off repeated failures and cancels retry timers on disposal", async () => {
  const register = vi.fn().mockRejectedValue(new Error("offline"));
  const report = vi.fn();
  const lifecycle = createEventLifecycle([{ register }], report);
  await lifecycle.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(register).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(register).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(register).toHaveBeenCalledTimes(3);
  expect(report).toHaveBeenCalledOnce();
  lifecycle.dispose();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(register).toHaveBeenCalledTimes(3);
});

it("retries a recovery snapshot without reinstalling an already healthy listener", async () => {
  const register = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(vi.fn());
  const recover = vi
    .fn()
    .mockRejectedValueOnce(new Error("snapshot failed"))
    .mockResolvedValue(undefined);
  const lifecycle = createEventLifecycle([{ register, recover }]);
  await lifecycle.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(register).toHaveBeenCalledTimes(2);
  expect(recover).toHaveBeenCalledTimes(2);
  lifecycle.dispose();
});

it("disposes a late registration without recovering an abandoned view", async () => {
  let resolve!: (value: Dispose) => void;
  const pending = new Promise<Dispose>((done) => {
    resolve = done;
  });
  const cleanup = vi.fn(),
    recover = vi.fn();
  const lifecycle = createEventLifecycle([{ register: () => pending, recover }]);
  const starting = lifecycle.start();
  lifecycle.dispose();
  resolve(cleanup);
  await starting;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(recover).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("releases all subscriptions even when a disposer or error reporter throws", async () => {
  const cleanup = vi.fn();
  const lifecycle = createEventLifecycle(
    [
      {
        register: async () => () => {
          throw new Error("cleanup failed");
        },
      },
      { register: async () => cleanup },
    ],
    () => {
      throw new Error("report failed");
    },
  );
  await lifecycle.start();
  lifecycle.dispose();
  lifecycle.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});
