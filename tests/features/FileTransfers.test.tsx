import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { FileTransfers } from "@/features/sftp/FileTransfers";
import { transferApi } from "@/lib/api/transfers";
import { useTransfers } from "@/store/transfers";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useTransfers.setState({
    items: [
      {
        id: "job",
        name: "file",
        direction: "transfer",
        status: "running",
        transferred: 0,
        total: 1000,
        updatedAt: Date.now(),
        durable: true,
        error: null,
      },
    ],
  });
});

it("applies a task limit and retains it across progress events", async () => {
  const save = vi.spyOn(transferApi, "setSpeedLimit").mockResolvedValue(undefined);
  render(<FileTransfers />);
  fireEvent.click(screen.getByRole("button", { name: "Task speed limit" }));
  const input = screen.getByRole("spinbutton");
  fireEvent.change(input, { target: { value: "128" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
  expect(save).toHaveBeenCalledWith("job", 128);
  expect(screen.queryByRole("spinbutton")).toBeNull();
  const item = useTransfers.getState().items[0]!;
  act(() => useTransfers.getState().apply({ ...item, transferred: 500 }));
  expect(screen.getByText("Task limit: 128 KiB/s")).toBeTruthy();
  expect(useTransfers.getState().items[0]?.speedLimitKib).toBe(128);
});

it("Escape discards a draft without changing the active limit", () => {
  const save = vi.spyOn(transferApi, "setSpeedLimit").mockResolvedValue(undefined);
  render(<FileTransfers />);
  fireEvent.click(screen.getByRole("button", { name: "Task speed limit" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "256" } });
  fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Escape" });
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("offers resume only for retained partial data and keeps cancelled cleanup retryable", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cancelled",
      error: "sftp.cancelCleanupFailed",
    })),
  }));
  render(<FileTransfers />);
  expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remove transfer and clean temporary files" }),
  ).toBeTruthy();
  expect(screen.getByText(/Temporary data could not be fully removed/)).toBeTruthy();
});
