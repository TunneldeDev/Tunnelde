import { expect, it, vi } from "vitest";
import {
  createResourceScope,
  ResourceScopeClosed,
  ResourceScopeError,
} from "@/lib/extensions/resourceScope";

it("releases resources once, in reverse order, and rejects work after parent abort", async () => {
  const parent = new AbortController();
  const scope = createResourceScope({ parent: parent.signal });
  const calls: number[] = [];
  scope.use(() => {
    calls.push(1);
  });
  const early = scope.use(() => {
    calls.push(2);
  });
  scope.use(() => {
    calls.push(3);
  });
  early();
  early();
  parent.abort();
  scope.dispose();
  early();
  scope.use(() => {
    calls.push(4);
  });
  expect(calls).toEqual([2, 3, 1, 4]);
  expect(scope.size).toBe(0);
  const start = vi.fn();
  await expect(scope.acquire(start, () => {})).rejects.toBeInstanceOf(ResourceScopeClosed);
  expect(start).not.toHaveBeenCalled();
});

it("reserves capacity before acquisition and releases a late result instead of delivering it", async () => {
  const scope = createResourceScope({ limit: 1 });
  let resolve!: (value: string) => void;
  const close = vi.fn();
  const pending = scope.acquire(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    close,
  );
  expect(scope.size).toBe(1);
  const start = vi.fn();
  await expect(scope.acquire(start, close)).rejects.toThrow("extension.scope.limit");
  expect(start).not.toHaveBeenCalled();
  scope.dispose();
  resolve("late resource");
  await expect(pending).rejects.toBeInstanceOf(ResourceScopeClosed);
  expect(close).toHaveBeenCalledExactlyOnceWith("late resource");
  expect(scope.size).toBe(0);
});

it("reports synchronous and async cleanup failures without interrupting remaining cleanup", async () => {
  const report = vi.fn();
  const scope = createResourceScope({ report });
  const last = vi.fn();
  scope.use(last);
  scope.use(async () => {
    throw new Error("async failure");
  });
  scope.use(() => {
    throw new Error("sync failure");
  });
  scope.dispose();
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
  expect(last).toHaveBeenCalledOnce();
  const broken = createResourceScope({
    report: () => {
      throw new Error("report failure");
    },
  });
  const cleanup = vi.fn();
  broken.use(cleanup);
  broken.use(() => {
    throw new Error("failure");
  });
  expect(() => broken.dispose()).not.toThrow();
  expect(cleanup).toHaveBeenCalledOnce();
});

it("cleans rejected over-quota resources and restores capacity after a failed acquisition", async () => {
  const scope = createResourceScope({ limit: 1 });
  await expect(
    scope.acquire(
      () => Promise.reject(new Error("open failed")),
      () => {},
    ),
  ).rejects.toThrow("open failed");
  expect(scope.size).toBe(0);
  const stop = scope.use(() => {});
  const extra = vi.fn();
  expect(() => scope.use(extra)).toThrow("extension.scope.limit");
  expect(extra).toHaveBeenCalledOnce();
  stop();
  expect(scope.size).toBe(0);
  const close = vi.fn();
  await expect(scope.acquire(() => "open", close)).resolves.toBe("open");
  scope.dispose();
  expect(close).toHaveBeenCalledExactlyOnceWith("open");
});

it("handles a pre-aborted parent and registrations made by abort handlers", () => {
  const parent = new AbortController();
  parent.abort();
  const stopped = createResourceScope({ parent: parent.signal });
  const cleanup = vi.fn();
  stopped.use(cleanup);
  expect(cleanup).toHaveBeenCalledOnce();
  const scope = createResourceScope();
  const reentrant = vi.fn();
  scope.signal.addEventListener("abort", () => scope.use(reentrant));
  scope.dispose();
  expect(reentrant).toHaveBeenCalledOnce();
  for (const limit of [0, -1, 0.5, Infinity, 4097])
    expect(() => createResourceScope({ limit })).toThrow("extension.scope.invalidLimit");
});

it("rejects immediately on abort even if acquisition never completes", async () => {
  const scope = createResourceScope();
  let lifetime!: AbortSignal;
  const pending = scope.acquire((signal) => {
    lifetime = signal;
    return new Promise<never>(() => {});
  }, vi.fn());
  const rejected = expect(pending).rejects.toBeInstanceOf(ResourceScopeClosed);
  scope.dispose();
  await rejected;
  expect(lifetime.aborted).toBe(true);
});

it("retains capacity after a deadline until late acquisition and async cleanup really finish", async () => {
  vi.useFakeTimers();
  try {
    const scope = createResourceScope({ limit: 1 });
    let resolve!: (value: string) => void;
    let finishCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((done) => {
          finishCleanup = done;
        }),
    );
    const pending = scope.acquire(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
      cleanup,
      { timeoutMs: 10 },
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "extension.scope.timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(scope.size).toBe(1);
    const start = vi.fn();
    await expect(scope.run(start)).rejects.toThrow("extension.scope.limit");
    expect(start).not.toHaveBeenCalled();
    resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("late");
    expect(scope.size).toBe(1);
    await expect(scope.run(start)).rejects.toThrow("extension.scope.limit");
    finishCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(scope.size).toBe(0);
    await expect(scope.run(() => "recovered")).resolves.toBe("recovered");
    expect(scope.size).toBe(0);
    scope.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("handles caller cancellation and late rejection without cancelling unrelated resources", async () => {
  const scope = createResourceScope();
  const caller = new AbortController();
  let reject!: (error: Error) => void;
  const close = vi.fn();
  await scope.acquire(() => "owned", close);
  const pending = scope.run(
    () =>
      new Promise<never>((_resolve, failed) => {
        reject = failed;
      }),
    { signal: caller.signal },
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "extension.scope.cancelled" });
  caller.abort();
  await rejected;
  expect(scope.signal.aborted).toBe(false);
  expect(close).not.toHaveBeenCalled();
  reject(new Error("late transport failure"));
  await vi.waitFor(() => expect(scope.size).toBe(1));
  scope.dispose();
  expect(close).toHaveBeenCalledExactlyOnceWith("owned");
});

it("limits deadlines to acquisition and keeps acquired signals attached to their owner", async () => {
  vi.useFakeTimers();
  try {
    const scope = createResourceScope();
    const caller = new AbortController();
    let lifetime!: AbortSignal;
    const close = vi.fn();
    await scope.acquire(
      (signal) => {
        lifetime = signal;
        return "resource";
      },
      close,
      { signal: caller.signal, timeoutMs: 10 },
    );
    caller.abort();
    await vi.advanceTimersByTimeAsync(20);
    expect(lifetime.aborted).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    scope.dispose();
    expect(lifetime.aborted).toBe(true);
    expect(close).toHaveBeenCalledExactlyOnceWith("resource");
  } finally {
    vi.useRealTimers();
  }
});

it("rejects invalid, expired and pre-cancelled operations before starting work", async () => {
  const scope = createResourceScope();
  const start = vi.fn();
  for (const timeoutMs of [-1, 0.5, Infinity, 2_147_483_648])
    await expect(scope.run(start, { timeoutMs })).rejects.toThrow("extension.scope.invalidTimeout");
  await expect(scope.run(start, { timeoutMs: 0 })).rejects.toBeInstanceOf(ResourceScopeError);
  const caller = new AbortController();
  caller.abort();
  await expect(scope.run(start, { signal: caller.signal })).rejects.toMatchObject({
    code: "extension.scope.cancelled",
  });
  expect(start).not.toHaveBeenCalled();
  expect(scope.size).toBe(0);
  scope.dispose();
});

it("cleans exactly once if acquisition closes its own scope before returning", async () => {
  const scope = createResourceScope();
  const close = vi.fn();
  await expect(
    scope.acquire(() => {
      scope.dispose();
      return "late";
    }, close),
  ).rejects.toBeInstanceOf(ResourceScopeClosed);
  expect(close).toHaveBeenCalledExactlyOnceWith("late");
});
