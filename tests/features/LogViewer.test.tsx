import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { LogViewer } from "@/features/settings/LogViewer";

const api = vi.hoisted(() => ({ logsRead: vi.fn(), openLogDir: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  api.openLogDir.mockResolvedValue(undefined);
  api.logsRead.mockResolvedValue({
    filename: "tunnelde.log.2026-11-05",
    diagnostic: "diagnostic entry",
    truncated: true,
    operations: [{ id: 1, timestamp: 1793820000000, action: "host.create", target: "host-id" }],
  });
});

it("shows operations and bounded diagnostics with a refresh and folder entry", async () => {
  render(<LogViewer />);
  fireEvent.click(screen.getByRole("button", { name: "View logs" }));
  expect(await screen.findByText("host.create")).toBeTruthy();
  expect(screen.getByText("host-id")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Application" }));
  expect(screen.getByText("diagnostic entry")).toBeTruthy();
  expect(screen.getByText(/Showing the latest 256 KiB/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));
  expect(api.openLogDir).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(api.logsRead).toHaveBeenCalledTimes(2));
});

it("shows failures and permits retry", async () => {
  api.logsRead.mockRejectedValueOnce(new Error("read failed"));
  render(<LogViewer />);
  fireEvent.click(screen.getByRole("button", { name: "View logs" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("host.create")).toBeTruthy();
});
