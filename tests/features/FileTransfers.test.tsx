import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { FileTransfers } from "@/features/sftp/FileTransfers";
import { transferApi } from "@/lib/api/transfers";
import { useTransfers } from "@/store/transfers";
import { useTransferPanel } from "@/store/transferPanel";
import { viewIsBusy } from "@/lib/session/viewState";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { TransferLocation } from "@/features/sftp/TransferLocation";

import { registerBackgroundTaskSources } from "@/app/backgroundTaskSources";

let stopSources: () => void;
afterEach(() => {
  cleanup();
  stopSources?.();
});

beforeEach(async () => {
  stopSources = registerBackgroundTaskSources();
  await i18n.changeLanguage("en-US");
  useTransferPanel.setState({ open: true, pinned: false, bounds: null });
  useSsh.setState({ sessions: [] });
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

it.each(["unknown", "rejected"] as const)(
  "retained %s cleanup shows its exact path without transfer progress or a connection dialog",
  async (settlement) => {
    const item = {
      ...useTransfers.getState().items[0]!,
      retainedCreation: true,
      retainedSettlement: settlement,
      status: "cleanupPending" as const,
      toHostId: "disconnected-host",
      fromHostId: null,
      toAddress: "user@server:22",
      toPath: "/target/file",
      artifactRecovery: "/target/.old.stage",
      error:
        settlement === "unknown" ? "sftp.retainedCreationUnknown" : "sftp.retainedCreationSettled",
    };
    useTransfers.setState({ items: [item] });
    const clear = vi
      .spyOn(transferApi, "clear")
      .mockResolvedValue(settlement === "rejected" ? null : item);
    render(<FileTransfers />);
    expect(screen.getByRole("article", { name: "Temporary directory · file" })).toBeTruthy();
    expect(screen.getByText("user@server:22:/target/.old.stage")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Temporary directory · file" }));
    expect(screen.queryByText(/Remaining:/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" })));
    expect(clear).toHaveBeenCalledWith("job");
    expect(screen.queryByRole("dialog", { name: /Connect|连接/ })).toBeNull();
    if (settlement === "rejected") {
      expect(screen.queryByRole("article")).toBeNull();
    } else {
      expect(screen.getByRole("article", { name: "Temporary directory · file" })).toBeTruthy();
    }
  },
);

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

it("explains preserved retained directory contents without misidentifying it as a transfer file", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      retainedCreation: true,
      retainedSettlement: "created",
      artifactRecovery: "/old.stage",
      error: "sftp.transferArtifactUnrecognized",
    })),
  }));
  render(<FileTransfers />);
  expect(
    screen.getByText(/directory contains other data or has an unexpected type or permissions/),
  ).toBeTruthy();
  expect(screen.getByText("Needs review")).toBeTruthy();
  expect(screen.queryByText(/cannot be identified as this task's original file/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
});

it("shows plugin attribution and cancellation without offering pause or unauthorized retry", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({ ...item, pluginId: "uploader" })),
  }));
  render(<FileTransfers />);
  expect(screen.queryByRole("button", { name: "Pause transfer" })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel transfer" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "file" }));
  expect(screen.getByText("Started by plugin: uploader")).toBeTruthy();
  act(() =>
    useTransfers.getState().apply({ ...useTransfers.getState().items[0]!, status: "failed" }),
  );
  expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remove transfer and clean temporary files" }),
  ).toBeTruthy();
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

it("shows a localized explanation when a directory move is rejected", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "failed",
      error: "sftp.directoryMoveUnavailable",
    })),
  }));
  render(<FileTransfers />);
  expect(
    screen.getByText(/Moving folders between sources is temporarily unavailable/),
  ).toBeTruthy();
  expect(screen.queryByText("sftp.directoryMoveUnavailable")).toBeNull();
});

it.each([
  ["sftp.moveRecoverySourcePresent", /an entry now exists at the source path/],
  ["sftp.moveRecoveryUnverified", /saved task cannot verify the current files/],
  ["sftp.moveSourceRetained", /source has been kept/],
  ["sftp.directoryMoveSourceChanged", /source folder contains new items/],
  ["sftp.namedStreamsMoveUnavailable", /source has Windows named data streams/],
])("explains interrupted source removal without expanding task details: %s", (error, message) => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "failed",
      error,
      fromPath: "/original/source.json",
      toPath: "/copied/target.json",
      fromAddress: "user@source:22",
      toAddress: "user@target:22",
    })),
  }));
  const { container } = render(<FileTransfers />);
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByText(error)).toBeNull();
  expect(container.querySelector(".transfer-task__details")).toBeTruthy();
  expect(screen.getByText("user@source:22:/original/source.json")).toBeTruthy();
  expect(screen.getByText("user@target:22:/copied/target.json")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remove transfer and clean temporary files" }),
  ).toBeTruthy();
  expect(container.querySelectorAll(".transfer-task__details")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "file" }));
  expect(container.querySelectorAll(".transfer-task__details")).toHaveLength(2);
  expect(screen.getAllByText("user@source:22:/original/source.json")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "file" }));
  expect(container.querySelectorAll(".transfer-task__details")).toHaveLength(1);
  expect(screen.getByText("user@source:22:/original/source.json")).toBeTruthy();
});

it("keeps ordinary failed transfers resumable and their details collapsed", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "failed",
      error: "sftp.transferTimedOut",
    })),
  }));
  const { container } = render(<FileTransfers />);
  expect(screen.getByRole("button", { name: "Resume transfer" })).toBeTruthy();
  expect(container.querySelector(".transfer-task__details")).toBeNull();
});

it("shows preserved backup copies as needing review and does not offer transfer retry", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "failed",
      error: "sftp.backupPreserved",
      backupRecovery: { backup: "/remote/.backup", destination: "/remote/file" },
    })),
  }));
  render(<FileTransfers />);
  expect(screen.getByText("Needs review")).toBeTruthy();
  expect(screen.getByText(/destination was written/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
  expect(screen.getByText("/remote/.backup")).toBeTruthy();
  expect(screen.getByText("/remote/file")).toBeTruthy();
});

it("opens local recovery folders inside the application", () => {
  const open = vi.spyOn(useWorkspace.getState(), "openFilePane").mockReturnValue("files:review");
  const item = { ...useTransfers.getState().items[0]!, fromHostId: null, fromSession: null };
  render(
    <TransferLocation
      item={item}
      side="from"
      path={"C:\\work\\source.txt"}
      label="Source"
      inspect
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Source folder" }));
  expect(open).toHaveBeenCalledWith(
    {
      source: { kind: "local" },
      path: "C:\\work",
      ownerSessionId: "local",
      remoteIdentity: undefined,
    },
    "This computer",
  );
});

it("explains pending directory acknowledgement and permits a later cleanup retry", async () => {
  const clear = vi.spyOn(transferApi, "clear").mockResolvedValue(null);
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      error: "sftp.transferCreationUnconfirmed",
      artifactRecovery: "/tmp/.tunnelde-job.stage",
    })),
  }));
  render(<FileTransfers />);
  expect(screen.getByText(/server has not confirmed creation/)).toBeTruthy();
  expect(screen.getByText(/removing the directory yourself does not confirm/)).toBeTruthy();
  expect(screen.getByText("/tmp/.tunnelde-job.stage")).toBeTruthy();
  expect(screen.queryByText("Needs review")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" })));
  expect(clear).toHaveBeenCalled();
});

it.each(["failed", "cleanupPending"] as const)(
  "preserves an unrecognized staging file and exposes its exact inspection folder: %s",
  async (status) => {
    const clear = vi.spyOn(transferApi, "clear").mockResolvedValue(null);
    const resume = vi.spyOn(transferApi, "resume").mockResolvedValue(undefined);
    const open = vi.spyOn(useWorkspace.getState(), "openFilePane").mockReturnValue("files:review");
    useTransfers.setState((state) => ({
      items: state.items.map((item) => ({
        ...item,
        status,
        error: "sftp.transferArtifactUnrecognized",
        artifactRecovery: "C:\\downloads\\.tunnelde-job.part",
        toSession: null,
        toHostId: null,
      })),
    }));
    render(<FileTransfers />);
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getByText(/cannot be identified as this task's original file/)).toBeTruthy();
    expect(screen.getByText("C:\\downloads\\.tunnelde-job.part")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume transfer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Temporary file to inspect folder" }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "local" },
        path: "C:\\downloads",
        ownerSessionId: "local",
      }),
      "This computer",
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name:
            status === "cleanupPending"
              ? "Retry cleanup"
              : "Remove transfer and clean temporary files",
        }),
      ),
    );
    expect(clear).toHaveBeenCalledWith("job");
    expect(resume).not.toHaveBeenCalled();
  },
);

it("does not inspect a disconnected, changed or unidentified remote as a local path", () => {
  const open = vi.spyOn(useWorkspace.getState(), "openFilePane").mockReturnValue("files:review");
  const item = {
    ...useTransfers.getState().items[0]!,
    fromHostId: "host",
    fromSession: "old",
    fromAddress: "user@original:22",
  };
  render(
    <TransferLocation item={item} side="from" path="/work/source.txt" label="Source" inspect />,
  );
  const button = screen.getByRole("button", { name: "Open Source folder" });
  expect(button).toHaveProperty("disabled", true);
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
});

it("inspects only a live connection matching the recorded host and address", () => {
  const open = vi.spyOn(useWorkspace.getState(), "openFilePane").mockReturnValue("files:review");
  const session = {
    id: "new",
    hostId: "host",
    address: "user@original:22",
    title: "Original",
    cols: 80,
    rows: 24,
    connectedAt: 1,
  };
  useSsh.setState({
    sessions: [
      { ...session, id: "changed", address: "user@different:22" },
      { ...session, id: "forward", purpose: "forwarding" },
      session,
    ],
  });
  const item = {
    ...useTransfers.getState().items[0]!,
    fromHostId: "host",
    fromSession: "old",
    fromAddress: "user@original:22",
  };
  render(
    <TransferLocation item={item} side="from" path="/work/source.txt" label="Source" inspect />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Source folder" }));
  expect(open).toHaveBeenCalledWith(
    {
      source: { kind: "remote", sessionId: "new" },
      path: "/work",
      ownerSessionId: "new",
      remoteIdentity: { hostId: "host", address: "user@original:22" },
    },
    "Original",
  );
  act(() => useSsh.setState({ sessions: [{ ...session, address: "user@changed:22" }] }));
  expect(screen.getByRole("button", { name: "Open Source folder" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("shows a backup recovery error without expanding task details", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      error: "sftp.backupRecoveryRequired",
    })),
  }));
  const { container } = render(<FileTransfers />);
  expect(screen.getByText(/backup is a hidden .tunnelde file/)).toBeTruthy();
  expect(container.querySelector(".transfer-task__details")).toBeNull();
});

it("explains a local cleanup conflict without promising recovery by reconnecting", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      error: "sftp.typeConflict",
      toHostId: null,
    })),
  }));
  render(<FileTransfers />);
  expect(
    screen.getByText(/Cleanup is incomplete. Review the error and retry cleanup/),
  ).toBeTruthy();
  expect(screen.getByText(/A file and folder cannot replace one another/)).toBeTruthy();
  expect(screen.queryByText(/will be cleaned when the destination reconnects/)).toBeNull();
  expect(screen.getByRole("button", { name: "Retry cleanup" })).toBeTruthy();
});

it("shows the specific backup and original destination for manual recovery", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      error: "sftp.backupRecoveryRequired",
      backupRecovery: {
        backup: "/remote/nested/.tunnelde-job.backup",
        destination: "/remote/nested/a.txt",
      },
    })),
  }));
  render(<FileTransfers />);
  expect(screen.getByText("Backup")).toBeTruthy();
  expect(screen.getByText("/remote/nested/.tunnelde-job.backup")).toBeTruthy();
  expect(screen.getByText("Original destination")).toBeTruthy();
  expect(screen.getByText("/remote/nested/a.txt")).toBeTruthy();
  expect(
    screen.queryByText(/Temporary data will be cleaned when the destination reconnects/),
  ).toBeNull();
});

it("warns when the file at a recorded backup path cannot be identified", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      error: "sftp.backupUnrecognized",
      backupRecovery: { backup: "/remote/.backup", destination: "/remote/file" },
    })),
  }));
  render(<FileTransfers />);
  expect(screen.getByText(/cannot be verified as the previous destination/)).toBeTruthy();
  expect(screen.getByText("/remote/.backup")).toBeTruthy();
  expect(screen.getByText("/remote/file")).toBeTruthy();
});

it("keeps the last known recovery paths visible after a reconnect failure", () => {
  useTransfers.setState((state) => ({
    items: state.items.map((item) => ({
      ...item,
      status: "cleanupPending",
      error: "sftp.reconnectRequired",
      toAddress: "user@example:22",
      backupRecovery: { backup: "/dir/.backup", destination: "/dir/file" },
    })),
  }));
  render(<FileTransfers />);
  expect(screen.getByText(/Last detected recovery location/)).toBeTruthy();
  expect(screen.getByText("user@example:22:/dir/.backup")).toBeTruthy();
  expect(screen.getByText("user@example:22:/dir/file")).toBeTruthy();
});

it("bulk clears finished and failed transfers and keeps deferred remote cleanup visible", async () => {
  const template = useTransfers.getState().items[0]!;
  const pending = {
    ...template,
    id: "failed",
    status: "cleanupPending" as const,
    updatedAt: Date.now(),
    fromHostId: null,
    toHostId: "offline",
    error: "sftp.reconnectRequired",
  };
  const clear = vi
    .spyOn(transferApi, "clear")
    .mockImplementation(async (id) => (id === "failed" ? pending : null));
  useTransfers.setState({
    items: [
      template,
      { ...template, id: "paused", status: "paused" },
      { ...template, id: "done", status: "done" },
      { ...template, id: "cancelled", status: "cancelled" },
      { ...template, id: "failed", status: "failed" },
    ],
  });
  render(<FileTransfers />);
  fireEvent.click(screen.getByRole("button", { name: "Clear finished tasks" }));
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(useTransfers.getState().items.map((item) => item.id)).toEqual([
      "job",
      "paused",
      "failed",
    ]),
  );
  expect(useTransfers.getState().items[2]?.status).toBe("cleanupPending");
  expect(
    screen.getByRole("button", { name: "Clear finished tasks" }).hasAttribute("disabled"),
  ).toBe(true);
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
