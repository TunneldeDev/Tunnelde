import { afterEach, expect, it } from "vitest";
import { createBackgroundTaskRunner } from "@/lib/extensions/backgroundTasks/execution";
import { useBackgroundTasks } from "@/lib/tasks/registry";
import { backgroundTasksBlockSuspension } from "@/lib/tasks/actions";
import type { FrontendBackgroundTaskContext } from "@/lib/extensions/contracts/backgroundTasks/execution";

const entries = () =>
  useBackgroundTasks.getState().items.filter((item) => item.source === "workbench");
afterEach(async () => {
  for (const entry of entries())
    await entry.actions?.find((action) => action.id === "clear")?.run();
});

it("reports validated copies, preserves operation results and rejects late or malformed reports", async () => {
  let retained!: FrontendBackgroundTaskContext;
  const api = createBackgroundTaskRunner(new AbortController().signal, () => {}, "test-plugin");
  const progress = { completed: 4, total: 10, unit: "items" as const };
  expect(
    await api.run({ title: "Index" }, (context) => {
      retained = context;
      context.report({ message: "Scanning", progress });
      progress.completed = 99;
      expect(entries()[0]!.progress!.completed).toBe(4);
      expect(() => context.report({ progress: { completed: NaN } })).toThrow("invalid");
      expect(() => context.report({ message: "X".repeat(4097) })).toThrow("invalid");
      return 42;
    }),
  ).toBe(42);
  expect(entries()[0]!.status).toBe("done");
  expect(entries()[0]!.pluginId).toBe("test-plugin");
  expect(() => retained.report({ message: "late" })).toThrow("inactive");
});

it("keeps cancelled uncooperative hidden work alive until actual settlement and holds quota", async () => {
  const runtime = new AbortController();
  const api = createBackgroundTaskRunner(
    runtime.signal,
    () => {
      if (runtime.signal.aborted) throw Error("closed");
    },
    "test-plugin",
  );
  const finish: (() => void)[] = [];
  const contexts: FrontendBackgroundTaskContext[] = [];
  const pending = Array.from({ length: 8 }, (_, index) =>
    api.run({ title: `Hidden ${index}`, visible: false }, (context) => {
      contexts.push(context);
      return new Promise<void>((resolve) => finish.push(resolve));
    }),
  );
  await expect(api.run({ title: "Ninth" }, () => {})).rejects.toThrow("limit");
  expect(backgroundTasksBlockSuspension()).toBe(true);
  runtime.abort();
  expect(contexts.every((context) => context.signal.aborted)).toBe(true);
  expect(entries().filter((entry) => entry.status === "running")).toHaveLength(8);
  expect(backgroundTasksBlockSuspension()).toBe(true);
  expect(() => contexts[0]!.report({ message: "late" })).toThrow("closed");
  await expect(api.run({ title: "After stop" }, () => {})).rejects.toThrow("closed");
  finish.forEach((resolve) => resolve());
  await Promise.allSettled(pending);
  expect(entries()).toHaveLength(0);
  expect(backgroundTasksBlockSuspension()).toBe(false);
});

it("exposes cancellation as a cooperative signal and preserves failure details", async () => {
  const api = createBackgroundTaskRunner(new AbortController().signal, () => {}, "test-plugin");
  let reject!: (error: unknown) => void, context!: FrontendBackgroundTaskContext;
  const pending = api.run({ title: "Cancellable" }, (value) => {
    context = value;
    return new Promise<void>((_, no) => {
      reject = no;
    });
  });
  const handled = pending.catch((error) => error);
  await entries()[0]!
    .actions!.find((action) => action.id === "cancel")!
    .run();
  expect(context.signal.aborted).toBe(true);
  expect(entries()[0]!.status).toBe("running");
  reject(context.signal.reason);
  await handled;
  expect(entries()[0]!.status).toBe("cancelled");
  await expect(
    api.run({ title: "Failure" }, () => {
      throw Error("Specific failure");
    }),
  ).rejects.toThrow("Specific failure");
  expect(entries().find((entry) => entry.title === "Failure")?.error).toBe("Specific failure");
});
