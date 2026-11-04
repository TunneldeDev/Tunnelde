import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { BackgroundTasks, BackgroundTaskStatusButton } from "@/features/tasks/BackgroundTasks";
import {
  registerBackgroundTaskSource,
  runBackgroundTask,
  useBackgroundTasks,
  type BackgroundTask,
} from "@/lib/tasks/background";
import { useBackgroundTaskPanel } from "@/store/backgroundTaskPanel";

let dispose: (() => void) | undefined;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useBackgroundTaskPanel.setState({ open: true, pinned: false, bounds: null });
});
afterEach(async () => {
  cleanup();
  dispose?.();
  dispose = undefined;
  for (const task of useBackgroundTasks.getState().items)
    await task.actions?.find((action) => action.id === "clear")?.run();
});

it("mixes sources, hides optional tasks and does not count invisible work", () => {
  dispose = registerBackgroundTaskSource({
    id: "ui-test",
    subscribe: () => () => {},
    snapshot: () => [
      {
        id: "visible",
        title: "Index workspace",
        status: "running",
        execution: "webview",
        updatedAt: 0,
        progress: { completed: 3, total: 10, unit: "items" },
      },
      {
        id: "hidden",
        title: "Hidden housekeeping",
        status: "running",
        execution: "webview",
        updatedAt: 0,
        visible: false,
      },
    ],
  });
  render(
    <>
      <BackgroundTaskStatusButton />
      <BackgroundTasks />
    </>,
  );
  expect(screen.getByText("1 task")).toBeTruthy();
  expect(screen.getByRole("article", { name: "Index workspace" })).toBeTruthy();
  expect(screen.queryByText("Hidden housekeeping")).toBeNull();
  expect(
    screen.getByRole("progressbar", { name: "Index workspace" }).getAttribute("aria-valuenow"),
  ).toBe("30");
  expect(
    screen
      .getByRole("progressbar", { name: "Background task progress" })
      .getAttribute("aria-valuenow"),
  ).toBe("30");
  expect(screen.getByText("30%")).toBeTruthy();
});

it("highlights active work and updates determinate, unknown, paused and failed feedback", () => {
  let changed = () => {};
  let items: BackgroundTask[] = [
    {
      id: "upload",
      title: "Upload archive.zip",
      status: "running",
      execution: "native",
      updatedAt: 0,
      progress: { completed: 5, total: 20, unit: "bytes" },
    },
  ];
  dispose = registerBackgroundTaskSource({
    id: "feedback",
    snapshot: () => items,
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  render(<BackgroundTaskStatusButton floating />);
  const button = screen.getByRole("button", { name: "Background tasks" });
  expect(button.classList.contains("is-running")).toBe(true);
  expect(button.title).toContain("Upload archive.zip");
  expect(screen.getByText("25%")).toBeTruthy();
  act(() => {
    items = [
      ...items,
      {
        id: "index",
        title: "Index workspace",
        status: "running",
        execution: "webview",
        updatedAt: 0,
      },
    ];
    changed();
  });
  expect(screen.queryByText("25%")).toBeNull();
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  expect(button.title).toContain("Index workspace");
  act(() => {
    items = items.map((item) => ({ ...item, status: "paused" }));
    changed();
  });
  expect(button.classList.contains("is-paused")).toBe(true);
  expect(screen.getByText("2 paused")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  act(() => {
    items = items.map((item) => ({ ...item, status: "attention" }));
    changed();
  });
  expect(button.classList.contains("needs-attention")).toBe(true);
  expect(button.title).toContain("2 tasks need attention");
});

it("averages per-task completion without adding incompatible byte and item units", () => {
  dispose = registerBackgroundTaskSource({
    id: "mixed-progress",
    subscribe: () => () => {},
    snapshot: () => [
      {
        id: "bytes",
        title: "Upload",
        status: "running",
        execution: "native",
        updatedAt: 0,
        progress: { completed: 50, total: 100, unit: "bytes" },
      },
      {
        id: "items",
        title: "Index",
        status: "running",
        execution: "webview",
        updatedAt: 0,
        progress: { completed: 1, total: 4, unit: "items" },
      },
    ],
  });
  render(<BackgroundTaskStatusButton />);
  expect(screen.getByText("37%")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toContain(
    "average per task",
  );
});

it("cancels cooperative work, waits for settlement, and clears completed records", async () => {
  let finish!: () => void;
  let result!: Promise<void>;
  act(() => {
    result = runBackgroundTask({ title: "Build search index" }, async ({ signal }) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      signal.throwIfAborted();
    });
  });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  render(<BackgroundTasks />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel task" }).hasAttribute("disabled")).toBe(true),
  );
  expect(screen.getByText("Running")).toBeTruthy();
  await act(async () => {
    finish();
    await rejected;
  });
  fireEvent.click(screen.getByRole("button", { name: /Finished/ }));
  expect(screen.getByText("Cancelled")).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Clear finished tasks" })),
  );
  expect(screen.getByText("No background tasks")).toBeTruthy();
});

it("handles source action failures in the row without losing the task", async () => {
  const retry = vi.fn().mockRejectedValue(Error("Try again later"));
  const task: BackgroundTask = {
    id: "failure",
    title: "Index workspace",
    status: "attention",
    execution: "native",
    updatedAt: 0,
    error: "Connection lost",
    actions: [{ id: "retry", label: "Retry indexing", run: retry }],
  };
  dispose = registerBackgroundTaskSource({
    id: "retry-test",
    subscribe: () => () => {},
    snapshot: () => [task],
  });
  render(<BackgroundTasks />);
  fireEvent.click(screen.getByRole("button", { name: "Retry indexing" }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(screen.getByRole("article", { name: "Index workspace" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry indexing" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
});

it("clears every removable record with one click while groups are collapsed and paginated", async () => {
  let changed = () => {};
  const clear = vi.fn((id: string) => {
    items = items.filter((item) => item.id !== id);
    changed();
  });
  let items: BackgroundTask[] = Array.from({ length: 31 }, (_, index) => ({
    id: String(index),
    title: `Finished ${index}`,
    status: index === 30 ? "attention" : "done",
    execution: "native",
    updatedAt: 0,
    actions: [{ id: "clear", label: "", run: () => clear(String(index)) }],
  }));
  items.push(
    ...(["running", "paused"] as const).map((status) => ({
      id: status,
      title: status,
      status,
      execution: "native" as const,
      updatedAt: 0,
      actions: [{ id: "clear", label: "", run: () => clear(status) }],
    })),
  );
  dispose = registerBackgroundTaskSource({
    id: "bulk-clear",
    snapshot: () => items,
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  render(<BackgroundTasks />);
  expect(screen.queryByRole("article", { name: "Finished 0" })).toBeNull();
  const button = screen.getByRole("button", { name: "Clear finished tasks" });
  fireEvent.click(button);
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(31));
  expect(items.map((item) => item.id)).toEqual(["running", "paused"]);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
});

it("keeps the bulk action busy until clearing settles and allows retrying failures", async () => {
  let finish!: () => void;
  const clear = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  dispose = registerBackgroundTaskSource({
    id: "bulk-busy",
    subscribe: () => () => {},
    snapshot: () => [
      {
        id: "one",
        title: "Finished",
        status: "done",
        execution: "native",
        updatedAt: 0,
        actions: [{ id: "clear", label: "", run: clear }],
      },
    ],
  });
  render(<BackgroundTasks />);
  const button = screen.getByRole("button", { name: "Clear finished tasks" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(clear).toHaveBeenCalledOnce();
  expect(button.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish());
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
});
