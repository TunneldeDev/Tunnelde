import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  workspace: {
    tabs: [{ id: "terminal:s1", kind: "terminal" }],
    openSftp: vi.fn(),
    openHistory: vi.fn(),
  },
  ssh: { sessions: [{ id: "s1" }], disconnect: vi.fn().mockResolvedValue(undefined) },
  settings: { settings: { recordTerminalHistory: false }, update: vi.fn() },
  clipboardReadText: vi.fn().mockResolvedValue("clipboard"),
  clipboardWriteText: vi.fn(),
  record: vi.fn(),
}));
vi.mock("@/store/workspace", () => ({ useWorkspace: { getState: () => mock.workspace } }));
vi.mock("@/store/ssh", () => ({ useSsh: { getState: () => mock.ssh } }));
vi.mock("@/store/settings", () => ({ useSettings: { getState: () => mock.settings } }));
vi.mock("@/lib/api/ipc", () => ({ api: mock }));
vi.mock("@/lib/session/history", () => ({ recordTerminalCommand: mock.record }));
vi.mock("@/features/terminal/terminalWindowPublication", () => ({
  terminalDisplaySession: () => ({ id: "s1", hostId: "host1" }),
}));
import { executeTerminalWindowAction } from "@/features/terminal/terminalWindowActions";
const lease = { panelId: "terminal:s1", windowId: "satellite", generation: 2 };
afterEach(() => {
  vi.clearAllMocks();
  mock.settings.settings.recordTerminalHistory = false;
});
it("derives the bound session and routes navigation through main", async () => {
  const show = vi.fn();
  await executeTerminalWindowAction(lease, { operation: "openSftp" }, show);
  expect(show).toHaveBeenCalledOnce();
  expect(mock.workspace.openSftp).toHaveBeenCalledWith({ id: "s1", hostId: "host1" });
  await executeTerminalWindowAction(lease, { operation: "disconnect" }, show);
  expect(mock.ssh.disconnect).toHaveBeenCalledWith("s1", expect.any(Function));
});
it("refuses another or closed workspace panel before effects", async () => {
  await expect(
    executeTerminalWindowAction(
      { ...lease, panelId: "terminal:another" },
      { operation: "disconnect" },
      vi.fn(),
    ),
  ).rejects.toThrow("staleOwner");
  expect(mock.ssh.disconnect).not.toHaveBeenCalled();
});
it("only records commands when the current main preference opts in", async () => {
  await executeTerminalWindowAction(lease, { operation: "recordCommand", command: "pwd" }, vi.fn());
  expect(mock.record).not.toHaveBeenCalled();
  mock.settings.settings.recordTerminalHistory = true;
  await executeTerminalWindowAction(lease, { operation: "recordCommand", command: "pwd" }, vi.fn());
  expect(mock.record).toHaveBeenCalledWith("host1", "pwd");
});
it("does not allow arbitrary preference keys or unregistered fonts", async () => {
  await expect(
    executeTerminalWindowAction(lease, { operation: "font", font: "arbitrary" }, vi.fn()),
  ).rejects.toThrow("invalid:monoFont");
  expect(mock.settings.update).not.toHaveBeenCalled();
});
