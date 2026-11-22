import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { formatErrorDetails, normalizeError, notifyError, translateError } from "@/lib/api/errors";
import { ToastHost } from "@/components/ui/overlay/Toast";
import { useToasts } from "@/store/toasts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  act(() => useToasts.setState({ items: [] }));
  vi.resetAllMocks();
});

it("keeps the specific validation key while presenting the generic category", async () => {
  await i18n.changeLanguage("zh-CN");
  const failure = normalizeError({
    code: "validation",
    message: "host.name.required",
  });
  expect(failure).toMatchObject({
    code: "validation",
    message: "host.name.required",
    severity: "warn",
  });
  expect(failure.userMessage).toBe("请检查标红的字段 · host.name.required");
});

it("logs structured code, detail keys and stack once and exposes them in toast details", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  invoke.mockResolvedValue(undefined);
  await i18n.changeLanguage("en-US");
  const error = Object.assign(new Error("host.name.required"), {
    code: "validation",
    details: { field: "name", password: "must-not-be-logged" },
  });
  render(<ToastHost />);
  await act(async () => {
    notifyError(error, { domain: "hosts", operation: "save" });
    await Promise.resolve();
  });
  expect(invoke).toHaveBeenCalledWith("logs_write", {
    entry: expect.objectContaining({
      domain: "hosts",
      level: "warn",
      operation: "save",
      message: "host.name.required",
      fields: expect.objectContaining({
        code: "validation",
        detailCount: 2,
      }),
    }),
  });
  expect(screen.getByText(/Check the highlighted fields/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByText("Details")));
  expect(screen.getAllByText(/host.name.required/).length).toBeGreaterThan(0);
  expect(formatErrorDetails(error)).toContain('"code": "validation"');
  await act(async () => {
    translateError(error);
    await Promise.resolve();
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("assigns debug severity to cancellation and retains non-IPC errors", () => {
  const cancelled = new DOMException("Cancelled", "AbortError");
  expect(normalizeError(cancelled)).toMatchObject({
    severity: "debug",
    message: "Cancelled",
  });
  expect(normalizeError(new Error("disk unavailable"))).toMatchObject({
    code: "runtime",
    message: "disk unavailable",
    severity: "error",
  });
});
