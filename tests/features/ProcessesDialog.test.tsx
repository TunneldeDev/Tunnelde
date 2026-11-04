import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteProcess } from "@/lib/api/types";

const { remoteProcesses, remoteKill } = vi.hoisted(() => ({
  remoteProcesses: vi.fn(),
  remoteKill: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: { remoteProcesses, remoteKill } }));
import i18n from "@/i18n/i18n";
import { ProcessesDialog } from "@/features/monitor/ProcessesDialog";
import { useDialogs } from "@/store/dialogs";

const process = (overrides: Partial<RemoteProcess> = {}): RemoteProcess => ({
  pid: 42,
  name: "worker",
  cpu: 291,
  cpuTotal: 36.375,
  memory: 10,
  rss: 1048576,
  startedAtTicks: 123,
  userName: "alice",
  groupName: "developers",
  uid: 1000,
  gid: 100,
  parentPid: 1,
  threads: 4,
  state: "Sl",
  ...overrides,
});
beforeEach(async () => {
  remoteProcesses.mockReset();
  remoteKill.mockReset().mockResolvedValue(undefined);
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  useDialogs.getState().close();
});

describe("process manager", () => {
  it("does not show processes from a previous server or accept its late result", async () => {
    let first!: (items: RemoteProcess[]) => void;
    let second!: (items: RemoteProcess[]) => void;
    remoteProcesses
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            second = resolve;
          }),
      );
    const view = render(<ProcessesDialog sessionId="old" onClose={() => undefined} />);
    await waitFor(() => expect(remoteProcesses).toHaveBeenCalledWith("old"));
    view.rerender(<ProcessesDialog sessionId="new" onClose={() => undefined} />);
    await waitFor(() => expect(remoteProcesses).toHaveBeenCalledWith("new"));
    await act(async () => second([process({ name: "new-server-process" })]));
    expect(await screen.findByText("new-server-process")).toBeTruthy();
    await act(async () => first([process({ name: "old-server-process" })]));
    expect(screen.queryByText("old-server-process")).toBeNull();
    expect(screen.getByText("new-server-process")).toBeTruthy();
  });

  it("shows normalized CPU, IO, TCP, GPU and selectable user/group details; unknown metrics stay unknown", async () => {
    remoteProcesses.mockResolvedValue([
      process({
        diskReadRate: 1024,
        diskWriteRate: 2048,
        networkRxRate: 4096,
        networkTxRate: 8192,
        gpuPercent: 75,
        gpuMemory: 2097152,
      }),
      process({ pid: 55, name: "root-worker", cpuTotal: undefined, userName: "root" }),
    ]);
    render(<ProcessesDialog sessionId="s" onClose={() => undefined} />);
    const worker = await screen.findByText("worker");
    expect(screen.getByText("36.4%")).toBeTruthy();
    expect(screen.queryByText("291.0%")).toBeNull();
    expect(screen.getByText("1.0 KB/s")).toBeTruthy();
    expect(screen.getByText("8.0 KB/s")).toBeTruthy();
    expect(screen.getByText("75.0%")).toBeTruthy();
    expect(screen.getByText("2.0 MB")).toBeTruthy();
    expect(
      within(screen.getByText("root-worker").closest("tr")!).getAllByText("—").length,
    ).toBeGreaterThan(2);
    fireEvent.click(worker);
    const details = screen.getByRole("region", { name: "Process details" });
    expect(within(details).getByText("developers")).toBeTruthy();
    expect(within(details).getByText("291.0%")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "root" } });
    expect(screen.queryByText("36.4%")).toBeNull();
    expect(screen.getByText("root-worker")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1000" } });
    expect(screen.getByText("36.4%")).toBeTruthy();
  });

  it("sorts numerically with unknown values last and renders only a page", async () => {
    remoteProcesses.mockResolvedValue(
      Array.from({ length: 140 }, (_, i) =>
        process({ pid: i + 2, name: `worker-${i}`, cpuTotal: i === 0 ? undefined : i / 2 }),
      ),
    );
    render(<ProcessesDialog sessionId="s" onClose={() => undefined} />);
    await screen.findByText("worker-139");
    expect(screen.getAllByRole("row")).toHaveLength(101);
    expect(screen.queryByText("worker-0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "CPU" }));
    expect(screen.getAllByRole("row")[1]!.textContent).toContain("worker-1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("worker-0")).toBeTruthy();
  });

  it("guards stop with process identity and never stops after the owning server changed", async () => {
    remoteProcesses.mockResolvedValue([process()]);
    const view = render(<ProcessesDialog sessionId="s" onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("worker"));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const confirmation = useDialogs.getState().dialog;
    expect(confirmation.kind).toBe("confirm");
    if (confirmation.kind !== "confirm") throw Error("missing confirmation");
    await act(async () => confirmation.onConfirm());
    expect(remoteKill).toHaveBeenCalledWith("s", 42, 123);
    view.rerender(<ProcessesDialog sessionId="other" onClose={() => undefined} />);
    await act(async () => confirmation.onConfirm());
    expect(remoteKill).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => confirmation.onConfirm());
    expect(remoteKill).toHaveBeenCalledTimes(1);
  });

  it("does not keep selection when a PID has been reused", async () => {
    remoteProcesses
      .mockResolvedValueOnce([process()])
      .mockResolvedValue([process({ startedAtTicks: 456 })]);
    render(<ProcessesDialog sessionId="s" onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("worker"));
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.queryByRole("region", { name: "Process details" })).toBeNull();
  });
});
