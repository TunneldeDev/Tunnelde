import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { ToastHost } from "@/components/ui/overlay/Toast";
import { useToasts } from "@/store/toasts";

afterEach(() => {
  vi.useRealTimers();
  act(() => useToasts.setState({ items: [] }));
});

it("keeps actionable errors visible and invokes their log action", () => {
  vi.useFakeTimers();
  const openLog = vi.fn();
  render(<ToastHost />);
  act(() =>
    useToasts
      .getState()
      .push("Plugin could not start", "error", { label: "Open log", onClick: openLog }),
  );
  act(() => vi.advanceTimersByTime(10_000));
  fireEvent.click(screen.getByRole("button", { name: "Open log" }));
  expect(openLog).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("Plugin could not start")).toBeNull();
});
