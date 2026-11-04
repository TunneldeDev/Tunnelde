import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundTaskHistory,
  clearFinishedBackgroundTasks,
  backgroundTasksBlockSuspension,
  registerBackgroundTaskSource,
  restoreBackgroundTaskHistory,
  runBackgroundTask,
  withBackgroundTask,
  useBackgroundTasks,
  type BackgroundTask,
  type BackgroundTaskContext,
} from "@/lib/tasks/background";

const stops: (() => void)[] = [];
const items = () => useBackgroundTasks.getState().items;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const task = (id: string): BackgroundTask => ({
  id,
  title: id,
  status: "running",
  execution: "native",
  updatedAt: 0,
});

it("bounds bulk clear concurrency, continues after errors and leaves hidden or unsupported work alone", async () => {
  let changed!: () => void;
  const finishes: (() => void)[] = [];
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  let tasks: BackgroundTask[] = Array.from({ length: 10 }, (_, index) => ({
    ...task(String(index)),
    status: "done",
    actions: [
      {
        id: "clear",
        label: "",
        run: async () => {
          calls.push(String(index));
          peak = Math.max(peak, ++active);
          await new Promise<void>((resolve) => finishes.push(resolve));
          active--;
          if (index === 2) throw Error("Keep failed record");
          tasks = tasks.filter((item) => item.id !== String(index));
          changed();
        },
      },
    ],
  }));
  tasks.push({
    ...task("hidden"),
    status: "done",
    visible: false,
    actions: [
      {
        id: "clear",
        label: "",
        run: () => {
          throw Error("hidden cleared");
        },
      },
    ],
  });
  tasks.push({ ...task("unsupported"), status: "attention" });
  stops.push(
    registerBackgroundTaskSource({
      id: "batch",
      snapshot: () => tasks,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
    }),
  );
  const clearing = clearFinishedBackgroundTasks();
  expect(calls).toHaveLength(4);
  for (let index = 0; index < 3; index++) {
    finishes.splice(0).forEach((finish) => finish());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  expect(await clearing).toHaveLength(1);
  expect(peak).toBe(4);
  expect(tasks.map((item) => item.id)).toEqual(["2", "hidden", "unsupported"]);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const task of items()) task.actions?.find((action) => action.id === "clear")?.run();
});

describe("background task sources", () => {
  it("namespaces task IDs and releases subscriptions on abort without removing another generation", () => {
    const lifetime = new AbortController();
    const unsubscribe = vi.fn();
    let changed!: () => void;
    let tasks = [task("same")];
    const stop = registerBackgroundTaskSource(
      {
        id: "one",
        snapshot: () => tasks,
        subscribe: (listener) => {
          changed = listener;
          return unsubscribe;
        },
      },
      lifetime.signal,
    );
    stops.push(
      stop,
      registerBackgroundTaskSource({
        id: "two",
        snapshot: () => [task("same")],
        subscribe: () => () => {},
      }),
    );
    expect(new Set(items().map((task) => task.key)).size).toBe(2);
    tasks = [{ ...task("same"), title: "updated" }];
    changed();
    expect(items().find((task) => task.source === "one")?.title).toBe("updated");
    lifetime.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(items().map((task) => task.source)).toEqual(["two"]);
    stops.push(
      registerBackgroundTaskSource({
        id: "one",
        snapshot: () => [task("replacement")],
        subscribe: () => () => {},
      }),
    );
    stop();
    changed();
    expect(items().some((task) => task.id === "replacement")).toBe(true);
  });

  it("rejects duplicate sources and task IDs and rolls back failed registration", () => {
    const source = { id: "unique", snapshot: () => [task("one")], subscribe: () => () => {} };
    stops.push(registerBackgroundTaskSource(source));
    expect(() => registerBackgroundTaskSource(source)).toThrow(/duplicate/);
    expect(() =>
      registerBackgroundTaskSource({
        ...source,
        id: "duplicate-items",
        snapshot: () => [task("same"), task("same")],
      }),
    ).toThrow(/Duplicate/);
    const stop = vi.fn();
    let snapshots = 0;
    expect(() =>
      registerBackgroundTaskSource({
        id: "broken",
        snapshot: () => {
          if (++snapshots === 2) throw Error("snapshot failed");
          return [];
        },
        subscribe: () => stop,
      }),
    ).toThrow("snapshot failed");
    expect(stop).toHaveBeenCalledOnce();
    stops.push(registerBackgroundTaskSource({ ...source, id: "broken" }));
    const lifetime = new AbortController();
    lifetime.abort();
    const subscribe = vi.fn();
    registerBackgroundTaskSource({ ...source, id: "aborted", subscribe }, lifetime.signal);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not block WebView suspension for native work, but includes hidden frontend work", () => {
    let tasks = [
      task("native"),
      { ...task("hidden"), execution: "webview" as const, visible: false },
    ];
    let changed!: () => void;
    stops.push(
      registerBackgroundTaskSource({
        id: "native-and-hidden",
        snapshot: () => tasks,
        subscribe: (listener) => {
          changed = listener;
          return () => {};
        },
      }),
    );
    expect(backgroundTasksBlockSuspension()).toBe(true);
    tasks = [task("native")];
    changed();
    expect(backgroundTasksBlockSuspension()).toBe(false);
  });
});

describe("cooperative task wrapper", () => {
  it("adapts existing functions with per-call titles and preserves arguments and results", async () => {
    const calculate = withBackgroundTask(
      (name: string, _count: number) => ({ title: name }),
      async (ctx, _name, count) => {
        ctx.report({ progress: { completed: count, unit: "items" } });
        return count * 2;
      },
    );
    expect(await calculate("Build index", 7)).toBe(14);
    expect(items()[0]?.title).toBe("Build index");
    expect(items()[0]?.progress?.completed).toBe(7);
  });
  it("returns the operation result, reports progress, and persists settled history without callbacks", async () => {
    const finished = deferred<number>();
    let context!: BackgroundTaskContext;
    const result = runBackgroundTask({ title: "Index files" }, (ctx) => {
      context = ctx;
      ctx.report({ message: "Scanning", progress: { completed: 3, total: 8, unit: "items" } });
      return finished.promise;
    });
    expect(backgroundTasksBlockSuspension()).toBe(true);
    expect(items()[0]?.progress?.completed).toBe(3);
    finished.resolve(42);
    expect(await result).toBe(42);
    expect(items()[0]?.status).toBe("done");
    expect(backgroundTasksBlockSuspension()).toBe(false);
    context.report({ message: "late" });
    expect(items()[0]?.message).toBe("Scanning");
    const history = JSON.parse(JSON.stringify(backgroundTaskHistory()));
    expect(history[0].actions).toBeUndefined();
    await items()[0]?.actions?.[0]?.run();
    expect(items()).toHaveLength(0);
    restoreBackgroundTaskHistory(history);
    expect(items()[0]?.status).toBe("done");
    expect(items()[0]?.actions?.[0]?.id).toBe("clear");
  });

  it("requests cancellation and waits for acknowledgement before releasing the WebView", async () => {
    const finished = deferred();
    let context!: BackgroundTaskContext;
    const result = runBackgroundTask({ title: "Work" }, (ctx) => {
      context = ctx;
      return finished.promise;
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await items()[0]
      ?.actions?.find((action) => action.id === "cancel")
      ?.run();
    expect(context.signal.aborted).toBe(true);
    expect(items()[0]?.status).toBe("running");
    expect(items()[0]?.actions?.[0]?.disabled).toBe(true);
    expect(backgroundTasksBlockSuspension()).toBe(true);
    finished.reject(context.signal.reason);
    await rejection;
    expect(items()[0]?.status).toBe("cancelled");
    expect(backgroundTasksBlockSuspension()).toBe(false);
  });

  it("keeps failures visible and never turns an unrelated failure into cancellation", async () => {
    const finished = deferred();
    const result = runBackgroundTask({ title: "Failing work" }, () => finished.promise);
    const rejection = expect(result).rejects.toThrow("failed to flush");
    await items()[0]?.actions?.[0]?.run();
    finished.reject(Error("failed to flush"));
    await rejection;
    expect(items()[0]?.status).toBe("attention");
    expect(items()[0]?.error).toBe("failed to flush");
  });

  it("supports invisible work, opt-out cancellation, and already cancelled parents", async () => {
    const finished = deferred();
    const result = runBackgroundTask(
      { title: "Hidden work", visible: false, cancellable: false },
      () => finished.promise,
    );
    expect(items()[0]?.visible).toBe(false);
    expect(items()[0]?.actions).toEqual([]);
    expect(backgroundTasksBlockSuspension()).toBe(true);
    finished.resolve();
    await result;
    expect(items()).toHaveLength(0);
    const parent = new AbortController();
    parent.abort();
    const work = vi.fn();
    await expect(
      runBackgroundTask({ title: "Aborted", signal: parent.signal }, work),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
    expect(backgroundTasksBlockSuspension()).toBe(false);
  });
});
