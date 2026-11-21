import { expect, it, vi } from "vitest";
import { createRetainedListStore } from "@/lib/data/retainedListStore";

it("shares readers, evicts abandoned responses and coalesces group invalidations", async () => {
  const pending: Array<(value: string[]) => void> = [];
  const load = vi.fn(() => new Promise<string[]>((resolve) => pending.push(resolve)));
  let changed!: () => void;
  const detach = vi.fn();
  const store = createRetainedListStore(load, (refresh) => {
    changed = refresh;
    return detach;
  });
  const one = store.subscribe(vi.fn()),
    two = store.subscribe(vi.fn());
  expect(load).toHaveBeenCalledTimes(1);
  one();
  one();
  expect(detach).not.toHaveBeenCalled();
  two();
  expect(detach).toHaveBeenCalledTimes(1);
  const three = store.subscribe(vi.fn());
  expect(load).toHaveBeenCalledTimes(2);
  pending[0]!(["abandoned"]);
  await Promise.resolve();
  await Promise.resolve();
  expect(store.getSnapshot().entries).toBeNull();
  for (let i = 0; i < 20; i++) changed();
  pending[1]!(["stale"]);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(store.getSnapshot().entries).toBeNull();
  expect(load).toHaveBeenCalledTimes(3);
  pending[2]!(["empty-group-without-rules"]);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(store.getSnapshot().entries).toEqual(["empty-group-without-rules"]);
  three();
  expect(store.getSnapshot().entries).toBeNull();
});
