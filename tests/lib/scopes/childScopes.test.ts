import { expect, it, vi } from "vitest";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { deferred } from "../../fixtures/plugins";
import discovery from "../../../src-tauri/src/plugins/extensions.json";
import { scopeLimits } from "@/lib/extensions/runtime/scopes/limits";

it("advertises the actual child-scope implementation and shared-budget limits", () => {
  expect(discovery.frontend.resourceScopes).toEqual({
    member: "resources.child",
    ownership: "module-descendants",
    budget: "shared-ancestors",
    ...scopeLimits,
    settlement: "retain-until-work-and-cleanup-settle",
    nativeOwnership: "unchanged",
  });
});

it("closes one panel's descendants without closing its sibling or module", () => {
  const root = createResourceScope({ limit: 8 });
  const first = root.child(),
    second = root.child();
  const nested = first.child();
  const cleanup = vi.fn(),
    sibling = vi.fn();
  nested.use(cleanup);
  second.use(sibling);
  expect(root.size).toBe(5);
  first.dispose();
  expect(root.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(nested.signal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(sibling).not.toHaveBeenCalled();
  expect(root.size).toBe(2);
  root.dispose();
  expect(sibling).toHaveBeenCalledOnce();
  expect(root.size).toBe(0);
});

it("shares the ancestor budget and preserves capacity until closed work and cleanup settle", async () => {
  const root = createResourceScope({ limit: 3 });
  const child = root.child({ limit: 1 });
  const start = deferred<string>(),
    cleanup = deferred<void>();
  const release = vi.fn(() => cleanup.promise);
  const pending = child.acquire(() => start.promise, release);
  const rejected = expect(pending).rejects.toThrow("extension.scope.closed");
  child.dispose();
  await rejected;
  expect(child.size).toBe(1);
  expect(root.size).toBe(1);
  const replacement = root.child();
  const stop = replacement.use(() => {});
  await expect(root.run(() => "should not start")).rejects.toThrow("extension.scope.limit");
  start.resolve("late resource");
  await vi.waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith("late resource"));
  expect(root.size).toBe(3);
  expect(child.size).toBe(1);
  await expect(root.run(() => "still not started")).rejects.toThrow("extension.scope.limit");
  cleanup.resolve();
  await vi.waitFor(() => expect(child.size).toBe(0));
  expect(root.size).toBe(2);
  await expect(root.run(() => "available")).resolves.toBe("available");
  stop();
  replacement.dispose();
  expect(root.size).toBe(0);
  root.dispose();
});

it("enforces every intermediate cap and releases rejected work without affecting sibling budgets", async () => {
  const root = createResourceScope({ limit: 10 });
  const panel = root.child({ limit: 2 });
  const nested = panel.child({ limit: 1 });
  const stop = nested.use(() => {});
  expect(panel.size).toBe(2);
  const begin = vi.fn();
  await expect(panel.run(begin)).rejects.toThrow("extension.scope.limit");
  await expect(nested.run(begin)).rejects.toThrow("extension.scope.limit");
  expect(begin).not.toHaveBeenCalled();
  await expect(root.run(() => "sibling work")).resolves.toBe("sibling work");
  stop();
  await expect(nested.run(() => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
  expect(panel.size).toBe(1);
  root.dispose();
  expect(root.size).toBe(0);
});

it("does not recover quota merely by timing out and disposing arbitrarily many children", async () => {
  vi.useFakeTimers();
  try {
    const root = createResourceScope({ limit: 3 });
    const first = root.child(),
      second = root.child();
    const delayed = deferred<string>();
    const pending = first.acquire(
      () => delayed.promise,
      () => {},
      { timeoutMs: 10 },
    );
    const rejected = expect(pending).rejects.toThrow("extension.scope.timeout");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    first.dispose();
    expect(root.size).toBe(2);
    const third = root.child();
    expect(() => root.child()).toThrow("extension.scope.limit");
    third.dispose();
    second.dispose();
    expect(root.size).toBe(1);
    delayed.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(root.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    root.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("counts rejected over-quota and closed-scope cleanup until it actually finishes", async () => {
  const root = createResourceScope({ limit: 2 });
  const child = root.child({ limit: 1 });
  const stop = child.use(() => {});
  const cleanup = deferred<void>();
  expect(() => child.use(() => cleanup.promise)).toThrow("extension.scope.limit");
  expect(root.size).toBe(3);
  stop();
  child.dispose();
  expect(root.size).toBe(1);
  const closedCleanup = deferred<void>();
  child.use(() => closedCleanup.promise);
  expect(root.size).toBe(2);
  await expect(root.run(() => "not started")).rejects.toThrow("extension.scope.limit");
  cleanup.resolve();
  closedCleanup.resolve();
  await vi.waitFor(() => expect(root.size).toBe(0));
  root.dispose();
});

it("handles pre-aborted and external child lifetimes without retaining empty slots", () => {
  const root = createResourceScope({ limit: 2 });
  const external = new AbortController();
  external.abort();
  const child = root.child({ signal: external.signal });
  expect(child.signal.aborted).toBe(true);
  expect(root.size).toBe(0);
  const active = new AbortController();
  const current = root.child({ signal: active.signal });
  const release = vi.fn();
  current.use(release);
  active.abort();
  expect(release).toHaveBeenCalledOnce();
  expect(root.size).toBe(0);
  root.dispose();
  expect(() => root.child()).toThrow("extension.scope.closed");
});

it("bounds child depth and rejects invalid child caps without leaking reservations", () => {
  const root = createResourceScope({ limit: 128 });
  for (const limit of [0, -1, 0.5, Infinity, 129])
    expect(() => root.child({ limit })).toThrow("extension.scope.invalidLimit");
  expect(root.size).toBe(0);
  let current = root;
  for (let depth = 0; depth < 32; depth++) current = current.child();
  expect(root.size).toBe(32);
  expect(() => current.child()).toThrow("extension.scope.depth");
  expect(root.size).toBe(32);
  root.dispose();
  expect(root.size).toBe(0);
});

it("keeps sibling cleanup running after reentrant disposal and reporter errors", async () => {
  const report = vi.fn(() => {
    throw new Error("reporter failed");
  });
  const root = createResourceScope({ report });
  const first = root.child(),
    second = root.child();
  const cleanup = vi.fn();
  first.use(() => {
    root.dispose();
    throw new Error("release failed");
  });
  second.use(cleanup);
  first.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  expect(root.size).toBe(0);
});

it("rejects malformed JavaScript callbacks and releases a failed child construction reservation", async () => {
  const root = createResourceScope({ limit: 1 });
  // Runtime plugins can be plain JavaScript; invalid callbacks must not leak capacity.
  expect(() => root.use(0 as never)).toThrow("extension.scope.invalidCleanup");
  const start = vi.fn();
  await expect(root.acquire(start, 0 as never)).rejects.toThrow("extension.scope.invalidCleanup");
  await expect(root.run(0 as never)).rejects.toThrow("extension.scope.invalidOperation");
  expect(start).not.toHaveBeenCalled();
  expect(() => root.child({ signal: 0 as never })).toThrow(TypeError);
  expect(root.size).toBe(0);
  const child = root.child();
  child.dispose();
  expect(root.size).toBe(0);
  root.dispose();
});
