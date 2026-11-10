import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { ToastHost } from "@/components/ui/overlay/Toast";
import { useToasts } from "@/store/toasts";

afterEach(() => {
  vi.useRealTimers();
  act(() => useToasts.setState({ items: [] }));
});

it("keeps actionable errors visible until their log action succeeds", async () => {
  vi.useFakeTimers();
  const openLog = vi.fn();
  render(<ToastHost />);
  act(() =>
    useToasts
      .getState()
      .push("Plugin could not start", "error", { label: "Open log", onClick: openLog }),
  );
  act(() => vi.advanceTimersByTime(10_000));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open log" })));
  expect(openLog).toHaveBeenCalledOnce();
  expect(screen.queryByText("Plugin could not start")).toBeNull();
});

it("runs an asynchronous action once and dismisses only its own notification on success", async () => {
  let complete!: () => void;
  const action = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  act(() => {
    useToasts.getState().push("First", "info", { label: "Open", onClick: action });
    useToasts.getState().push("Unrelated", "info");
  });
  render(<ToastHost />);
  const button = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(action).toHaveBeenCalledOnce();
  expect(screen.getByText("First")).toBeTruthy();
  await act(async () => complete());
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.getByText("Unrelated")).toBeTruthy();
});

it.each(["throw", "reject"])(
  "reports a %s and leaves the action available for retry",
  async (mode) => {
    let failed = true;
    const action = vi.fn(() => {
      if (failed) {
        if (mode === "throw") throw new Error("Unable to open log");
        return Promise.reject(new Error("Unable to open log"));
      }
    });
    act(() => useToasts.getState().push("Original", "error", { label: "Retry", onClick: action }));
    render(<ToastHost />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Unable to open log")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    failed = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(action).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Original")).toBeNull();
  },
);

it("ignores a late action failure after the notification was dismissed", async () => {
  let fail!: (error: Error) => void;
  act(() =>
    useToasts.getState().push("Original", "error", {
      label: "Open",
      onClick: () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    }),
  );
  render(<ToastHost />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => fail(new Error("Already dismissed")));
  expect(useToasts.getState().items).toEqual([]);
});
