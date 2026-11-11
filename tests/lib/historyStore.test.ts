import { expect, it, vi } from "vitest";
import { createHistoryStore } from "@/features/history/historyStore";
import type { HistoryEntry } from "@/lib/api/types";

const row = (id: number): HistoryEntry => ({
  id,
  command: `cmd ${id}`,
  hostId: "host",
  executedAt: id,
});
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("collapses invalidations into a trailing read and never publishes stale data", async () => {
  let finish!: (rows: HistoryEntry[]) => void;
  const load = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue([row(2)]);
  const store = createHistoryStore(load, vi.fn()),
    receive = vi.fn();
  store.subscribe(receive);
  const stop = store.start();
  for (let i = 0; i < 50; i++) store.refresh();
  expect(load).toHaveBeenCalledOnce();
  finish([row(1)]);
  await tick();
  expect(load).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().entries).toEqual([row(2)]);
  expect(receive).toHaveBeenCalledTimes(2);
  stop();
});

it("does not lose an invalidation dispatched by a subscriber during publication", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce([row(1)])
    .mockResolvedValue([row(2)]);
  const store = createHistoryStore(load, vi.fn());
  store.subscribe(() => {
    if (store.getSnapshot().entries?.[0]?.id === 1) store.refresh();
  });
  const stop = store.start();
  await tick();
  expect(load).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().entries?.[0]?.id).toBe(2);
  stop();
});

it("fences unmount and lifecycle replay, preserves rows on error and supports explicit retry", async () => {
  let finish!: (rows: HistoryEntry[]) => void;
  const report = vi.fn(),
    load = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce([row(2)])
      .mockRejectedValueOnce(Error("offline"))
      .mockResolvedValue([row(3)]);
  const store = createHistoryStore(load, report);
  const oldStop = store.start();
  oldStop();
  const stop = store.start();
  await tick();
  finish([row(1)]);
  await tick();
  expect(store.getSnapshot().entries).toEqual([row(2)]);
  store.refresh();
  await tick();
  expect(store.getSnapshot().error).toBeInstanceOf(Error);
  expect(store.getSnapshot().entries).toEqual([row(2)]);
  expect(report).toHaveBeenCalledOnce();
  store.refresh();
  await tick();
  expect(store.getSnapshot()).toMatchObject({ busy: false, error: null, entries: [row(3)] });
  stop();
  store.refresh();
  expect(load).toHaveBeenCalledTimes(4);
});
