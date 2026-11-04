import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { FileTransfers } from "@/features/sftp/FileTransfers";
import { transferApi } from "@/lib/api/transfers";
import { useTransfers } from "@/store/transfers";
import { useTransferPanel } from "@/store/transferPanel";
import { viewIsBusy } from "@/lib/session/viewState";

import { registerBackgroundTaskSources } from "@/app/backgroundTaskSources";

let stopSources: () => void;
afterEach(() => stopSources?.());

beforeEach(async () => {
  stopSources = registerBackgroundTaskSources();
  await i18n.changeLanguage("en-US");
  useTransferPanel.setState({ open: true, pinned: false, bounds: null });
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
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Background tasks" }), {
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

it("shows queued work without a false speed and lets the user cancel or pause it", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({ ...item, phase: "queued" })),
  }));
  render(<FileTransfers />);
  expect(screen.getByText("Queued")).toBeTruthy();
  expect(screen.queryByText("Calculating speed…")).toBeNull();
  expect(screen.getByRole("button", { name: "Pause transfer" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel transfer" })).toBeTruthy();
});

function mockPanelRect() {
  const panel = screen.getByRole("dialog", { name: "Background tasks" });
  vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: parseFloat(panel.style.left || "300"),
        y: parseFloat(panel.style.top || "200"),
        width: parseFloat(panel.style.width || "460"),
        height: parseFloat(panel.style.height || "300"),
      }) as DOMRect,
  );
  return panel;
}

it("moves and resizes from the keyboard, restores on reopen and resets the saved layout", () => {
  render(<FileTransfers />);
  mockPanelRect();
  fireEvent.keyDown(screen.getByRole("button", { name: "Background tasks" }), {
    key: "ArrowLeft",
  });
  expect(useTransferPanel.getState().bounds?.x).toBe(290);
  fireEvent.keyDown(screen.getByRole("button", { name: /Resize task window/ }), {
    key: "ArrowDown",
    shiftKey: true,
  });
  expect(useTransferPanel.getState().bounds?.height).toBe(301);
  const saved = useTransferPanel.getState().bounds;
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  act(() => useTransferPanel.getState().show());
  const panel = screen.getByRole("dialog", { name: "Background tasks" });
  expect(panel.style.left).toBe(`${saved?.x}px`);
  expect(panel.style.height).toBe("301px");
  fireEvent.click(screen.getByRole("button", { name: "Reset task window layout" }));
  expect(useTransferPanel.getState().bounds).toBeNull();
  expect(localStorage.getItem("tunnelde.transferPanel.bounds")).toBeNull();
  expect(panel.style.left).toBe("");
});

it("clamps a restored layout and repositions it when the viewport shrinks", () => {
  useTransferPanel.setState({ bounds: { x: 2000, y: 2000, width: 460, height: 300 } });
  render(<FileTransfers />);
  const panel = mockPanelRect();
  expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(
    innerWidth,
  );
  expect(parseFloat(panel.style.top) + parseFloat(panel.style.height)).toBeLessThanOrEqual(
    innerHeight,
  );
  fireEvent(window, new Event("resize"));
  expect(useTransferPanel.getState().bounds?.x).toBe(parseFloat(panel.style.left));
});

it("previews pointer movement without persisting each step and Escape cancels without closing", () => {
  render(<FileTransfers />);
  const panel = mockPanelRect();
  const handle = screen.getByRole("button", { name: "Background tasks" });
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
  const pointer = (name: string, x: number, y: number) => {
    const event = new MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(handle, event);
  };
  pointer("pointerdown", 350, 220);
  expect(viewIsBusy()).toBe(true);
  pointer("pointermove", 250, 120);
  expect(panel.style.left).toBe("200px");
  expect(useTransferPanel.getState().bounds).toBeNull();
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(useTransferPanel.getState().open).toBe(true);
  expect(panel.style.left).toBe("");
  expect(document.body.style.cursor).toBe("");
  expect(viewIsBusy()).toBe(false);
  pointer("pointerdown", 350, 220);
  pointer("pointermove", 250, 120);
  pointer("pointerup", 250, 120);
  expect(useTransferPanel.getState().bounds).toMatchObject({ x: 200, y: 100 });
  expect(viewIsBusy()).toBe(false);
});
