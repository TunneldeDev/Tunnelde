import { afterEach, expect, it, vi } from "vitest";
import {
  registerBackgroundTaskSource,
  runBackgroundTaskAction,
  useBackgroundTasks,
} from "@/lib/tasks/registry";
import { createBackgroundTasksContext } from "@/lib/extensions/backgroundTasks/context";
import { guardBackgroundTasksProvider } from "@/lib/extensions/backgroundTasks/provider";
import type { BackgroundTask } from "@/lib/tasks/model";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));
const task = (id: string): BackgroundTask => ({
  id,
  title: id,
  updatedAt: 0,
  execution: "native",
  status: "running",
});
const items = () => useBackgroundTasks.getState().items;

it("does not resurrect a source aborted inside subscribe or a subsequent snapshot", () => {
  const parent = new AbortController(),
    unsubscribe = vi.fn();
  let changed!: () => void;
  stops.push(
    registerBackgroundTaskSource(
      {
        id: "reentrant",
        snapshot: () => [task("one")],
        subscribe: (listener) => {
          changed = listener;
          parent.abort();
          return unsubscribe;
        },
      },
      parent.signal,
    ),
  );
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(items().some((item) => item.source === "reentrant")).toBe(false);
  changed();
  expect(items().some((item) => item.source === "reentrant")).toBe(false);
  const second = new AbortController();
  let reads = 0;
  stops.push(
    registerBackgroundTaskSource(
      {
        id: "snapshot-abort",
        snapshot: () => {
          if (++reads === 2) second.abort();
          return [task("two")];
        },
        subscribe: () => unsubscribe,
      },
      second.signal,
    ),
  );
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(items().some((item) => item.source === "snapshot-abort")).toBe(false);
});

it("reserves source identity before invoking a reentrant first snapshot", () => {
  const subscribe = vi.fn(() => () => {});
  stops.push(
    registerBackgroundTaskSource({
      id: "reserved",
      snapshot: () => {
        expect(() =>
          registerBackgroundTaskSource({ id: "reserved", snapshot: () => [], subscribe }),
        ).toThrow("duplicate");
        return [task("one")];
      },
      subscribe,
    }),
  );
  expect(subscribe).toHaveBeenCalledOnce();
});

it("copies published source progress and rejects stale/disabled actions and duplicate pending calls", async () => {
  let changed!: () => void, finish!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let tasks = [
    {
      ...task("one"),
      progress: { completed: 1 },
      actions: [{ id: "cancel", label: "Cancel", run }],
    },
  ];
  stops.push(
    registerBackgroundTaskSource({
      id: "actions",
      snapshot: () => tasks,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
    }),
  );
  const original = items().find((item) => item.source === "actions")!;
  tasks[0]!.progress.completed = 99;
  expect(original.progress!.completed).toBe(1);
  const pending = runBackgroundTaskAction(original, "cancel");
  expect(() => runBackgroundTaskAction(original, "cancel")).toThrow("busy");
  changed(); // A progress publication must not release the in-flight action lock.
  expect(() =>
    runBackgroundTaskAction(
      items().find((item) => item.source === "actions")!,
      "cancel",
    ),
  ).toThrow("busy");
  finish();
  await pending;
  tasks = [{ ...tasks[0]!, title: "Replacement" }];
  changed();
  expect(() => runBackgroundTaskAction(original, "cancel")).toThrow("changed");
  expect(run).toHaveBeenCalledOnce();
});

it("projects only visible immutable DTOs in bounded pages with opaque revision identities", async () => {
  const run = vi.fn();
  const tasks: BackgroundTask[] = Array.from({ length: 270 }, (_, index) => ({
    ...task(String(index)),
    privateSecret: "never",
    actions: [{ id: "cancel", label: "Cancel", run }],
  }));
  tasks.push({ ...task("hidden"), visible: false });
  stops.push(
    registerBackgroundTaskSource({
      id: "projection",
      snapshot: () => tasks,
      subscribe: () => () => {},
    }),
  );
  let valid = true;
  const context = createBackgroundTasksContext(
    { revision: "one", presentation: "floating" },
    items(),
    () => valid,
  );
  const first = context.read({ revision: "one" });
  expect(first.total).toBe(270);
  expect(first.items).toHaveLength(128);
  expect(first.items[0]!.key).toBe("task:0");
  expect(first.items[0]).not.toHaveProperty("privateSecret");
  expect(first.items[0]!.actions[0]).not.toHaveProperty("run");
  expect(Object.isFrozen(first.items[0]!.actions[0])).toBe(true);
  expect(context.read({ revision: "one", offset: first.nextOffset! }).items).toHaveLength(128);
  expect(context.read({ revision: "one", offset: 256 }).items).toHaveLength(14);
  expect(() => context.read({ revision: "old" })).toThrow("changed");
  for (const offset of [-1, 0.5, NaN, Infinity, 271])
    expect(() => context.read({ revision: "one", offset })).toThrow("invalid");
  await context.runAction({ revision: "one", key: first.items[0]!.key, actionId: "cancel" });
  expect(run).toHaveBeenCalledOnce();
  valid = false;
  await expect(
    context.runAction({ revision: "one", key: first.items[0]!.key, actionId: "cancel" }),
  ).rejects.toThrow("changed");
  expect(context.read({ revision: "one" }).items).toHaveLength(128);
});

it("bounds page text, reauthorizes retained reads and separately checks cross-source write access", async () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    ...task(String(index)),
    message: "M".repeat(10000),
    error: "E".repeat(10000),
  }));
  stops.push(
    registerBackgroundTaskSource({ id: "text", snapshot: () => tasks, subscribe: () => () => {} }),
  );
  const context = createBackgroundTasksContext(
    { revision: "frame", presentation: "embedded" },
    items(),
    () => true,
  );
  const first = context.read({ revision: "frame" });
  expect(JSON.stringify(first.items).length).toBeLessThanOrEqual(65536);
  expect(first.items[0]!.message).toHaveLength(4096);
  expect(first.nextOffset).not.toBeNull();
  const access = vi.fn();
  const api = guardBackgroundTasksProvider(
    { ...context, Entries: () => null },
    access,
    () => false,
  );
  expect(api.capabilities.actions).toBe(false);
  api.read({ revision: "frame" });
  expect(access).toHaveBeenCalledWith(false);
  await expect(
    api.runAction({ revision: "frame", key: "task:0", actionId: "cancel" }),
  ).rejects.toThrow("permission");
  access.mockImplementation(() => {
    throw Error("revoked");
  });
  expect(() => api.read({ revision: "frame" })).toThrow("revoked");
});

it("keeps unrelated source publications from replacing exact action identities", async () => {
  const run = vi.fn();
  stops.push(
    registerBackgroundTaskSource({
      id: "stable",
      snapshot: () => [{ ...task("one"), actions: [{ id: "retry", label: "Retry", run }] }],
      subscribe: () => () => {},
    }),
  );
  const original = items().find((item) => item.source === "stable")!;
  stops.push(
    registerBackgroundTaskSource({
      id: "unrelated",
      snapshot: () => [task("two")],
      subscribe: () => () => {},
    }),
  );
  expect(items().find((item) => item.source === "stable")).toBe(original);
  expect(Object.isFrozen(original)).toBe(true);
  await runBackgroundTaskAction(original, "retry");
  expect(run).toHaveBeenCalledOnce();
});

it("does not strand paging on escaped text and oversized action descriptors", () => {
  stops.push(
    registerBackgroundTaskSource({
      id: "escaped",
      subscribe: () => () => {},
      snapshot: () => [
        {
          ...task("one"),
          message: "\u0000".repeat(4096),
          error: "\u0000".repeat(4096),
          actions: Array.from({ length: 16 }, (_, i) => ({
            id: String(i),
            label: "\u0000".repeat(256),
            run: () => {},
          })),
        },
      ],
    }),
  );
  const context = createBackgroundTasksContext(
    { revision: "escaped", presentation: "floating" },
    items(),
    () => true,
  );
  const page = context.read({ revision: "escaped" });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.actions.length).toBeGreaterThan(0);
  expect(page.items[0]!.actions.length).toBeLessThan(16);
  expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(65536);
});

it("retains registered source identity if its descriptor changes during a callback", () => {
  const source = {
    id: "captured",
    snapshot: () => {
      source.id = "mutated";
      return [task("one")];
    },
    subscribe: () => () => {},
  };
  const stop = registerBackgroundTaskSource(source);
  stops.push(stop);
  expect(items().some((item) => item.source === "captured")).toBe(true);
  expect(items().some((item) => item.source === "mutated")).toBe(false);
  stop();
  expect(items().some((item) => item.source === "captured")).toBe(false);
});
