import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedMounts } from "@/features/plugins/SharedMounts";
import i18n from "@/i18n/i18n";
import type { PluginInfo } from "@/lib/api/types";
import type { MountSnapshot } from "@/lib/extensions/contracts/mounts/runtime";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@/lib/api/ipc", () => ({ api: {}, isTauri: () => true }));
vi.mock("@/lib/events/native", () => ({ nativeEvents: { on: mock.on } }));

const plugin: PluginInfo = {
  id: "sshfs-lite", name: "SSHFS Lite", version: "1.0.0", apiVersion: 1,
  description: null, error: null, path: "sshfs-lite", runtime: "declarative",
  status: "running", runtimeId: "plugin-run", commands: [],
  views: [{ id: "main", kind: "sharedMounts", title: "Mounts" }],
  permissions: ["hosts.read", "mounts.read", "mounts.write", "mounts.hostDetails"],
};
const surface = { pluginId: plugin.id, viewId: "main", contributionId: "mounts", hostId: "host" };
const snapshot: MountSnapshot = {
  hostId: "host", revision: "rev", runtimeRevision: "runtime-rev",
  groups: [{ revision: "group-rev", value: { id: "group", hostId: "host", name: "Group", autoReconnect: true } }],
  rules: [{ revision: "rule-rev", value: {
    id: "rule", hostId: "host", groupId: "group", name: "Data", readOnly: true,
    remotePath: "/data", mountPoint: "/mnt/data", autoMount: true,
  } }],
  connections: [],
  ruleStates: [{ ruleId: "rule", groupId: "group", revision: "rule-rev", phase: "running",
    runtimeId: "mount-run", sessionId: "session", error: null, desired: true }],
};

function grants(permissions: string[]) {
  usePluginSecurity.setState(({ state }) => ({
    state: { ...state, restricted: false, grants: { [plugin.id]: permissions } },
  }));
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mock.invoke.mockReset().mockImplementation(async (_, { method }) => {
    switch (method) {
      case "mounts.rules.snapshot": return snapshot;
      case "mounts.legacy.list": return { items: [] };
      case "mounts.dependencies.get": return { available: true };
      case "mounts.runtime.stop": return { id: "op", phase: "running", items: [] };
      case "mounts.operations.get": return { id: "op", phase: "succeeded", items: [] };
      default: throw new Error(method);
    }
  });
  mock.on.mockReset().mockResolvedValue(undefined);
  usePlugins.setState({ items: [plugin] });
  grants(plugin.permissions);
});
afterEach(cleanup);

it("renders the same snapshot read-only and releases listeners when hidden", async () => {
  grants(plugin.permissions.filter(p => p !== "mounts.write"));
  const view = render(<SharedMounts {...surface} />);
  expect(await screen.findByText("Data")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Unmount" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add group" })).toBeNull();
  const [event, invalidate, signal] = mock.on.mock.calls[0]!;
  expect(event).toBe("mounts://changed");
  mock.invoke.mockClear();
  await act(async () => invalidate());
  expect(mock.invoke).toHaveBeenCalledWith("plugin_shared_mounts_action", expect.objectContaining({
    method: "mounts.rules.snapshot", params: { hostId: "host" },
  }));
  view.rerender(<SharedMounts {...surface} visible={false} />);
  expect(signal.aborted).toBe(true);
  mock.invoke.mockClear();
  await act(async () => invalidate());
  expect(mock.invoke).not.toHaveBeenCalled();
});

it("passes the current rule revision and mount instance and refreshes the operation receipt", async () => {
  render(<SharedMounts {...surface} />);
  fireEvent.click(await screen.findByRole("button", { name: "Unmount" }));
  expect(mock.invoke).toHaveBeenCalledWith("plugin_shared_mounts_action", {
    surface: { pluginId: plugin.id, runtimeId: "plugin-run", viewId: "main", contributionId: "mounts" },
    method: "mounts.runtime.stop", params: { id: "rule", expectedRevision: "rule-rev", runtimeId: "mount-run" },
  });
  await waitFor(() => expect(screen.getByText(/Operation: Completed/)).toBeTruthy());
});
