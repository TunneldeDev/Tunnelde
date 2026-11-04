import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { FileTransfers } from "@/features/sftp/FileTransfers";
import { transferApi } from "@/lib/api/transfers";
import { useTransfers } from "@/store/transfers";
import { useTransferPanel } from "@/store/transferPanel";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useTransferPanel.setState({ open: true, pinned: false });
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
  fireEvent.click(screen.getByRole("button", { name: /Finished/ }));
  expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remove transfer and clean temporary files" }),
  ).toBeTruthy();
  expect(screen.getByText(/Temporary data could not be fully removed/)).toBeTruthy();
});

it("starts collapsed and does not mount every task detail when there are many transfers", () => {
  const template = useTransfers.getState().items[0]!;
  useTransfers.setState({
    items: Array.from({ length: 70 }, (_, n) => ({ ...template, id: String(n), name: `job-${n}` })),
  });
  const { container } = render(<FileTransfers />);
  expect(screen.getAllByRole("article")).toHaveLength(20);
  expect(container.querySelectorAll(".transfer-task__details")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Show 50 more" }));
  expect(screen.getAllByRole("article")).toHaveLength(40);
  fireEvent.click(screen.getByRole("button", { name: /In progress/ }));
  expect(screen.queryAllByRole("article")).toHaveLength(0);
});

it("closes on Escape and restores focus to the invoking control", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  render(<FileTransfers />);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Background transfers" }), {
    key: "Escape",
  });
  expect(useTransferPanel.getState().open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("keeps controls and order stable while other tasks report progress", () => {
  const template = useTransfers.getState().items[0]!;
  useTransfers.setState({ items: [template, { ...template, id: "second", name: "second" }] });
  render(<FileTransfers />);
  const button = screen.getAllByRole("button", { name: "Pause transfer" })[0]!;
  button.focus();
  act(() => useTransfers.getState().apply({ ...template, transferred: 600 }));
  expect(screen.getAllByRole("article")[0]?.getAttribute("aria-label")).toBe("file");
  expect(document.activeElement).toBe(button);
});
