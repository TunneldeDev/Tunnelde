import { afterEach, expect, it, vi } from "vitest";
import { createTaskProjection, useTaskProjection } from "@/lib/panels/taskProjection";
import { registerBackgroundTaskSource } from "@/lib/tasks/registry";
import type { BackgroundTask } from "@/lib/tasks/model";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});
function source() {
  let receive = () => {};
  const run = vi.fn().mockResolvedValue(null);
  const initial = (): BackgroundTask => ({
    id: "same/key 世界",
    title: "task",
    status: "running",
    updatedAt: 1,
    execution: "native",
    actions: [{ id: "pause", label: "Pause", run }],
  });
  let items: BackgroundTask[] = [initial()];
  const stop = registerBackgroundTaskSource({
    id: "qa",
    snapshot: () => items,
    subscribe: (fn) => {
      receive = fn;
      return () => {};
    },
  });
  cleanup.push(stop);
  return {
    stop,
    run,
    initial,
    publish: (next: BackgroundTask[]) => {
      items = next;
      receive();
    },
  };
}
it("transports explicit data and action descriptors, never callbacks; progress does not retire action tickets", async () => {
  const s = source(),
    p = createTaskProjection();
  cleanup.push(p.dispose);
  const first = useTaskProjection.getState().items[0]!;
  expect(first.actions[0]).not.toHaveProperty("run");
  expect(first.ticket).toMatch(/^[a-f0-9-]+$/);
  s.publish([{ ...s.initial(), progress: { completed: 3, total: 10 } }]);
  const next = useTaskProjection.getState().items[0]!;
  expect(next.ticket).toBe(first.ticket);
  await p.run(first.key, first.ticket, "pause");
  expect(s.run).toHaveBeenCalledOnce();
});
it("stale tickets cannot act on a replacement source or a disappeared/recreated task with the same key", async () => {
  const s = source(),
    p = createTaskProjection();
  cleanup.push(p.dispose);
  const first = useTaskProjection.getState().items[0]!;
  s.publish([]);
  s.publish([s.initial()]);
  expect(useTaskProjection.getState().items[0]!.ticket).not.toBe(first.ticket);
  await expect(p.run(first.key, first.ticket, "pause")).rejects.toThrow("changed");
  const previous = useTaskProjection.getState().items[0]!;
  s.stop();
  const replacement = source();
  await expect(p.run(previous.key, previous.ticket, "pause")).rejects.toThrow("changed");
  expect(replacement.run).not.toHaveBeenCalled();
});
it("rechecks current disabled/visible action state and releases ticket registries on teardown", async () => {
  const s = source(),
    p = createTaskProjection();
  cleanup.push(p.dispose);
  const first = useTaskProjection.getState().items[0]!;
  s.publish([
    { ...s.initial(), actions: [{ id: "pause", label: "Pause", run: s.run, disabled: true }] },
  ]);
  await expect(p.run(first.key, first.ticket, "pause")).rejects.toThrow("actionUnavailable");
  s.publish([{ ...s.initial(), visible: false }]);
  expect(useTaskProjection.getState().items).toEqual([]);
  await expect(p.run(first.key, first.ticket, "pause")).rejects.toThrow("changed");
  p.dispose();
  expect(useTaskProjection.getState().items).toEqual([]);
});

it("fences a replaced projection and never lets late disposal erase the new owner's model", async () => {
  const s = source(),
    first = createTaskProjection();
  cleanup.push(first.dispose);
  const old = useTaskProjection.getState().items[0]!;
  const second = createTaskProjection();
  cleanup.push(second.dispose);
  const current = useTaskProjection.getState().items[0]!;
  expect(current.ticket).not.toBe(old.ticket);
  first.dispose();
  expect(useTaskProjection.getState().items[0]).toEqual(current);
  await expect(first.run(old.key, old.ticket, "pause")).rejects.toThrow("changed");
  await second.run(current.key, current.ticket, "pause");
  expect(s.run).toHaveBeenCalledOnce();
});
