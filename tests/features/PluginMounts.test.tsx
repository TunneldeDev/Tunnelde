import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { PluginMounts } from "@/features/plugins/PluginMounts";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), authorize: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/store/pluginSecurity", () => ({ authorizePluginAction: mocks.authorize }));
vi.mock("@/lib/api/ipc", () => ({ api: {}, isTauri: () => true }));
const session = (id: string) => ({
  id,
  hostId: id,
  title: id,
  address: `${id}:22`,
  cols: 80,
  rows: 24,
  connectedAt: 1,
});
const mount = {
  id: "mount",
  sessionId: "server-one",
  remotePath: "/home/me",
  mountPoint: "Z:\\",
  readOnly: true,
};
let available: boolean;
let records: (typeof mount)[];
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  available = true;
  records = [];
  mocks.authorize.mockResolvedValue(true);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "plugin_mounts_action") {
      if (args.method === "dependencies")
        return { available, platform: "windows", transport: "slave", executable: "sshfs.exe" };
      if (args.method === "list") return records;
      if (args.method === "mount") {
        records = [mount];
        return mount;
      }
      if (args.method === "unmount") {
        records = [];
        return null;
      }
    }
  });
  useSsh.setState({ sessions: [session("server-one"), session("server-two")] });
  useDialogs.setState({ confirm: vi.fn() });
});
const renderPanel = async () => {
  await act(async () => render(<PluginMounts pluginId="sshfs-lite" />));
  fireEvent.change(screen.getByLabelText("Remote directory"), { target: { value: "/home/me" } });
  fireEvent.change(screen.getByLabelText("Local mount point"), { target: { value: "Z:\\" } });
};

it("mounts read-only through the selected session and requires confirmation to force unmount", async () => {
  await renderPanel();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Mount" })));
  expect(mocks.authorize).toHaveBeenCalledWith("sshfs-lite");
  expect(mocks.invoke).toHaveBeenCalledWith("plugin_mounts_action", {
    pluginId: "sshfs-lite",
    method: "mount",
    params: { sessionId: "server-one", remotePath: "/home/me", mountPoint: "Z:\\", readOnly: true },
  });
  expect(screen.getByText("Z:\\")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Force…" }));
  expect(useDialogs.getState().confirm).toHaveBeenCalledWith(
    expect.objectContaining({ danger: true }),
  );
  expect(mocks.invoke.mock.calls.some(([, args]) => args.method === "unmount")).toBe(false);
});

it("disables mounting and provides guidance when dependencies are unavailable", async () => {
  available = false;
  await renderPanel();
  expect((screen.getByRole("button", { name: "Mount" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Install WinFsp and SSHFS-Win/)).toBeTruthy();
  expect(mocks.authorize).not.toHaveBeenCalled();
});

it("keeps the selected machine pinned after disconnect instead of switching to another host", async () => {
  await renderPanel();
  await act(async () => useSsh.setState({ sessions: [session("server-two")] }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "SSH session" }).textContent).toContain(
      "Disconnected session",
    ),
  );
  expect((screen.getByRole("button", { name: "Mount" }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.some(([, args]) => args.method === "mount")).toBe(false);
});

it("refreshes retained cleanup records after a failed mount", async () => {
  const invoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "plugin_mounts_action" && args.method === "mount") {
      records = [mount];
      throw new Error("Mount startup failed");
    }
    return invoke(command, args);
  });
  await renderPanel();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Mount" })));
  expect(screen.getByRole("alert").textContent).toContain("Mount startup failed");
  expect(screen.getByText("Z:\\")).toBeTruthy();
});
