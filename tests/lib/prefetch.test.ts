// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it, vi } from "vitest";

import { createPrefetchQueue } from "@/lib/files/prefetch";

const deferred = () => {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

describe("directory prefetch queue", () => {
  it("shares two slots across panes and eventually drains every requested directory", async () => {
    const reads = Array.from({ length: 9 }, () => deferred());
    const started: number[] = [];
    const committed: string[] = [];
    const queue = createPrefetchQueue<string>({ enabled: () => true, cached: () => false });
    const job = (index: number) => ({
      key: String(index),
      read: () => {
        started.push(index);
        return reads[index]!.promise;
      },
      commit: (value: string) => {
        committed.push(value);
      },
    });
    queue.replace("a", [0, 1, 2, 3, 4].map(job));
    queue.replace("b", [5, 6, 7, 8].map(job));
    await flush();
    expect(started).toEqual([0, 1]);
    for (let index = 0; index < reads.length; index++) {
      reads[index]!.resolve(String(index));
      await flush();
      expect(started.length - committed.length).toBeLessThanOrEqual(2);
    }
    expect(started).toHaveLength(9);
    expect(committed).toHaveLength(9);
  });

  it("pauses new background work during foreground navigation and ignores its old result", async () => {
    const old = deferred();
    const commit = vi.fn();
    const readNext = vi.fn(async () => "next");
    const queue = createPrefetchQueue<string>({
      enabled: () => true,
      cached: () => false,
      concurrency: 1,
    });
    queue.replace("a", [{ key: "old", read: () => old.promise, commit }]);
    await flush();
    const release = queue.foreground("a", "old");
    queue.replace("b", [{ key: "next", read: readNext, commit }]);
    old.resolve("stale");
    await flush();
    expect(commit).not.toHaveBeenCalled();
    expect(readNext).not.toHaveBeenCalled();
    release();
    await flush();
    expect(commit).toHaveBeenCalledExactlyOnceWith("next");
  });

  it("rejects results started before an invalidation and drains fresh tasks afterwards", async () => {
    const old = deferred();
    const commit = vi.fn();
    const queue = createPrefetchQueue<string>({
      enabled: () => true,
      cached: () => false,
      concurrency: 1,
    });
    queue.replace("a", [{ key: "same", read: () => old.promise, commit }]);
    await flush();
    queue.invalidate();
    queue.replace("a", [{ key: "same", read: async () => "fresh", commit }]);
    old.resolve("stale");
    await flush();
    expect(commit).toHaveBeenCalledExactlyOnceWith("fresh");
  });

  it("discards queued and in-flight work after preloading is disabled", async () => {
    let enabled = true;
    const old = deferred();
    const readNext = vi.fn(async () => "next");
    const commit = vi.fn();
    const queue = createPrefetchQueue<string>({
      enabled: () => enabled,
      cached: () => false,
      concurrency: 1,
    });
    queue.replace("a", [
      { key: "old", read: () => old.promise, commit },
      { key: "next", read: readNext, commit },
    ]);
    await flush();
    enabled = false;
    queue.invalidate();
    old.resolve("stale");
    await flush();
    expect(commit).not.toHaveBeenCalled();
    expect(readNext).not.toHaveBeenCalled();
  });

  it("retains another pane's same directory request when the original pane navigates", async () => {
    const old = deferred();
    const commit = vi.fn();
    const secondRead = vi.fn(async () => "fresh");
    const queue = createPrefetchQueue<string>({
      enabled: () => true,
      cached: () => false,
      concurrency: 1,
    });
    queue.replace("a", [{ key: "shared", read: () => old.promise, commit }]);
    queue.replace("b", [{ key: "shared", read: secondRead, commit }]);
    await flush();
    queue.replace("a", []);
    old.resolve("stale");
    await flush();
    expect(secondRead).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledExactlyOnceWith("fresh");
  });

  it("deduplicates cached folders and continues after failed reads", async () => {
    const cached = new Set(["cached"]);
    const read = vi.fn(async () => "good");
    const commit = vi.fn((value: string) => cached.add(value));
    const queue = createPrefetchQueue<string>({
      enabled: () => true,
      cached: (key) => cached.has(key),
      concurrency: 1,
    });
    queue.replace("a", [
      { key: "cached", read, commit },
      {
        key: "bad",
        read: async () => {
          throw new Error("failed");
        },
        commit,
      },
      { key: "good", read, commit },
    ]);
    queue.replace("b", [{ key: "good", read, commit }]);
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledExactlyOnceWith("good");
  });
});
