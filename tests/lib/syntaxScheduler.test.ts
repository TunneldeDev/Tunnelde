import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingSyntaxCalls, scheduleLatestSyntaxCall } from "@/lib/plugins/syntaxScheduler";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("automatic syntax call scheduler", () => {
  it("keeps one real call in flight and coalesces to the newest request", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const calls: string[] = [];
    const run = (id: string, promise: Promise<number>) => () => {
      calls.push(id);
      return promise;
    };
    const a = scheduleLatestSyntaxCall("provider:runtime", run("first", first.promise));
    const b = scheduleLatestSyntaxCall("provider:runtime", run("second", second.promise));
    const c = scheduleLatestSyntaxCall("provider:runtime", run("third", third.promise));
    expect(calls).toEqual(["first"]);
    expect(pendingSyntaxCalls("provider:runtime")).toBe(2);
    first.resolve(1);
    await expect(a).resolves.toBe(1);
    await vi.waitFor(() => expect(calls).toEqual(["first", "third"]));
    await expect(b).resolves.toBeNull();
    third.resolve(3);
    await expect(c).resolves.toBe(3);
    expect(pendingSyntaxCalls("provider:runtime")).toBe(0);
  });

  it("does not release the slot while an abandoned IPC is still pending", async () => {
    const first = deferred<number>();
    const controller = new AbortController();
    const calls: string[] = [];
    const a = scheduleLatestSyntaxCall(
      "provider:runtime",
      () => {
        calls.push("first");
        return first.promise;
      },
      controller.signal,
    );
    controller.abort();
    await expect(a).resolves.toBeNull();
    expect(pendingSyntaxCalls("provider:runtime")).toBe(1);
    const second = deferred<number>();
    const b = scheduleLatestSyntaxCall("provider:runtime", () => {
      calls.push("second");
      return second.promise;
    });
    expect(calls).toEqual(["first"]);
    first.resolve(1);
    await vi.waitFor(() => expect(calls).toEqual(["first", "second"]));
    second.resolve(2);
    await expect(b).resolves.toBe(2);
    expect(pendingSyntaxCalls("provider:runtime")).toBe(0);
  });

  it("keeps independent runtimes from blocking one another", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const a = scheduleLatestSyntaxCall("provider:a", () => first.promise);
    const b = scheduleLatestSyntaxCall("provider:b", () => second.promise);
    second.resolve(2);
    await expect(b).resolves.toBe(2);
    first.resolve(1);
    await expect(a).resolves.toBe(1);
  });
});
