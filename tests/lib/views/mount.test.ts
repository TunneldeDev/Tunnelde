import { expect, it, vi } from "vitest";
import { createViewMount } from "@/lib/extensions/runtime/views/mount";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { deferred } from "../../fixtures/plugins";

it("does not acquire during construction and creates a fresh lifetime after committed-effect replay", () => {
  const root = createResourceScope();
  const open = vi.fn(() => root.child());
  const mount = createViewMount(open, vi.fn());
  expect(mount.snapshot()).toBeNull();
  expect(open).not.toHaveBeenCalled();
  const closeFirst = mount.activate();
  const first = mount.snapshot()!;
  expect(root.size).toBe(1);
  closeFirst();
  expect(first.signal.aborted).toBe(true);
  const closeSecond = mount.activate();
  const second = mount.snapshot()!;
  closeFirst();
  expect(second).not.toBe(first);
  expect(second.signal.aborted).toBe(false);
  expect(mount.snapshot()).toBe(second);
  closeSecond();
  expect(root.size).toBe(0);
});

it("closes forgotten work immediately while charging late asynchronous cleanup to the module", async () => {
  const root = createResourceScope();
  const mount = createViewMount(() => root.child(), vi.fn());
  const close = mount.activate();
  const late = deferred<string>(),
    cleanup = deferred<void>();
  const cleaned = vi.fn(() => cleanup.promise);
  const pending = mount.snapshot()!.acquire(() => late.promise, cleaned);
  const rejected = expect(pending).rejects.toThrow("extension.scope.closed");
  close();
  await rejected;
  expect(mount.snapshot()).toBeNull();
  expect(root.size).toBe(1);
  late.resolve("resource");
  await vi.waitFor(() => expect(cleaned).toHaveBeenCalledWith("resource"));
  expect(root.size).toBe(1);
  cleanup.resolve();
  await vi.waitFor(() => expect(root.size).toBe(0));
});

it("reports a denied or retired admission once without publishing a scope or retrying", () => {
  const root = createResourceScope();
  const report = vi.fn();
  const denied = createViewMount(() => {
    throw new Error("denied");
  }, report);
  denied.activate()();
  expect(report).toHaveBeenCalledOnce();
  expect(denied.snapshot()).toBeNull();
  const retired = createViewMount(
    () => root.child(),
    report,
    (close) => {
      close();
      return close;
    },
  );
  retired.activate()();
  expect(retired.snapshot()).toBeNull();
  expect(root.size).toBe(0);
  expect(report).toHaveBeenCalledTimes(2);
});

it("notifies the mounted owner on module retirement and detaches its subscriptions", () => {
  const root = createResourceScope();
  const mount = createViewMount(() => root.child(), vi.fn());
  const changed = vi.fn();
  const unsubscribe = mount.subscribe(changed);
  const close = mount.activate();
  expect(changed).toHaveBeenCalledOnce();
  root.dispose();
  expect(mount.snapshot()).toBeNull();
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
  close();
  expect(changed).toHaveBeenCalledTimes(2);
});
