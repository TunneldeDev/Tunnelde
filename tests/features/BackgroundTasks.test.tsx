import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("30");
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
