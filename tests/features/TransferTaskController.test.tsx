import { usePanelWindows } from "@/store/panelWindows";
import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransferTask } from "@/features/sftp/TransferTask";
import {
  TransferTaskControllerScope,
  transferLocation,
  type TransferTaskController,
} from "@/features/sftp/transferTaskController";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { useTransfers, type TransferItem } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";
const item: TransferItem = {
  id: "job",
  name: "qa.file",
  direction: "transfer",
  status: "running",
  transferred: 10,
  total: 100,
  error: null,
  updatedAt: 1,
  durable: true,
  fromPath: "/src/qa.file",
  toPath: "/dst/qa.file",
  toHostId: "host",
  toAddress: "qa@example:22",
};
function controller() {
  return {
    id: item.id,
    pause: vi.fn(),
    cancel: vi.fn(),
    clear: vi.fn(),
    setSpeedLimit: vi.fn().mockResolvedValue(true),
    location: vi.fn().mockReturnValue({ available: true, open: vi.fn() }),
  } satisfies TransferTaskController;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders a supplied remote task and sends controls to its coordinator without hydrating or mutating the main transfer store", async () => {
  const local = {
    pause: vi.spyOn(useTransfers.getState(), "pause"),
    cancel: vi.spyOn(useTransfers.getState(), "cancel"),
    clear: vi.spyOn(useTransfers.getState(), "clear"),
    limit: vi.spyOn(useTransfers.getState(), "setSpeedLimit"),
  };
  const backend = controller();
  render(
    <TransferTaskControllerScope value={backend}>
      <TransferTask item={item} now={1} onResume={vi.fn()} />
    </TransferTaskControllerScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Pause transfer" }));
  await waitFor(() => expect(backend.pause).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel transfer" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
  await waitFor(() => expect(backend.cancel).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Task speed limit" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Task speed limit" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "128" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(backend.setSpeedLimit).toHaveBeenCalledExactlyOnceWith(128));
  for (const spy of Object.values(local)) expect(spy).not.toHaveBeenCalled();
});
it("preserves disclosure and unfinished speed-limit draft across a real component remount using the shared capsule", () => {
  const backend = controller(),
    source = createPanelViewState();
  const content = (state: typeof source) => (
    <PanelViewStateScope controller={state}>
      <TransferTaskControllerScope value={backend}>
        <TransferTask item={item} now={1} onResume={vi.fn()} />
      </TransferTaskControllerScope>
    </PanelViewStateScope>
  );
  const view = render(content(source));
  fireEvent.click(screen.getByRole("button", { name: "Task speed limit" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "256" } });
  const captured = source.capture();
  view.unmount();
  render(content(createPanelViewState(captured)));
  expect(screen.getByRole("spinbutton")).toHaveProperty("value", "256");
  expect(screen.getByRole("button", { name: "qa.file" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
});
it("reports a rejected speed-limit action, keeps the draft and allows retry without unhandled rejection", async () => {
  const backend = controller();
  backend.setSpeedLimit.mockRejectedValueOnce(new Error("lease changed"));
  render(
    <TransferTaskControllerScope value={backend}>
      <TransferTask item={item} now={1} onResume={vi.fn()} />
    </TransferTaskControllerScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Task speed limit" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "512" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "lease changed");
  expect(screen.getByRole("spinbutton")).toHaveProperty("value", "512");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
  expect(backend.setSpeedLimit).toHaveBeenCalledTimes(2);
});
it("selects recovery locations by closed kind and never opens a raw local workspace path from a remote task", async () => {
  const backend = controller(),
    open = vi.fn(),
    local = vi.spyOn(useWorkspace.getState(), "openFilePane");
  backend.location.mockReturnValue({ available: true, open });
  const failed = {
    ...item,
    status: "failed" as const,
    error: "sftp.backupPreserved",
    backupRecovery: { backup: "/dst/.qa.backup", destination: "/dst/qa.file" },
  };
  render(
    <TransferTaskControllerScope value={backend}>
      <TransferTask item={failed} now={1} onResume={vi.fn()} />
    </TransferTaskControllerScope>,
  );
  expect(transferLocation(failed, "backup")).toBe("/dst/.qa.backup");
  expect(backend.location).toHaveBeenCalledWith("backup");
  expect(backend.location).toHaveBeenCalledWith("backupDestination");
  fireEvent.click(screen.getByRole("button", { name: "Open Backup folder" }));
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(local).not.toHaveBeenCalled();
});
it("does not invoke a second action before the first invocation completes", async () => {
  const backend = controller();
  let resolve!: () => void;
  backend.pause.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  render(
    <TransferTaskControllerScope value={backend}>
      <TransferTask item={item} now={1} onResume={vi.fn()} />
    </TransferTaskControllerScope>,
  );
  const pause = screen.getByRole("button", { name: "Pause transfer" });
  fireEvent.click(pause);
  fireEvent.click(pause);
  await waitFor(() => expect(backend.pause).toHaveBeenCalledOnce());
  await act(async () => resolve());
});

it("fails closed instead of using local stores when a satellite forgets its explicit controller", () => {
  const before = usePanelWindows.getState().windowId;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  usePanelWindows.setState({ windowId: "satellite" });
  try {
    expect(() => render(<TransferTask item={item} now={1} onResume={vi.fn()} />)).toThrow(
      "unsupportedView",
    );
  } finally {
    usePanelWindows.setState({ windowId: before });
    consoleError.mockRestore();
  }
});
