import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { HostDetailsSections } from "@/features/hosts/HostDetailsSections";

vi.mock("@/features/plugins/PluginComponentView", () => ({
  PluginComponentView: ({
    pluginId,
    hostDetails,
  }: {
    pluginId: string;
    hostDetails: { hostId: string };
  }) => (
    <p>
      {pluginId}:{hostDetails.hostId}
    </p>
  ),
}));
vi.mock("@/lib/api/ipc", () => ({ api: {}, isTauri: () => true }));

const plugin = (id: string, mounts = true): PluginInfo => ({
  id,
  name: id,
  version: "1.0.0",
  apiVersion: 1,
  description: null,
  error: null,
  path: id,
  runtime: "frontend",
  status: "running",
  frontend: { entry: "ui/main.mjs", sdk: "^0.1.0" },
  commands: [],
  views: [{ id: "details", title: id, kind: "component" }],
  permissions: [
    "ui.trusted",
    "hosts.read",
    ...(mounts ? ["mounts.read", "mounts.hostDetails"] : []),
  ],
  hostDetails: [
    { id: "details", title: id, viewId: "details", ...(mounts ? { kind: "mounts" as const } : {}) },
  ],
});
const plugins = [plugin("sshfs"), plugin("sshfs-lite"), plugin("notes", false)];
beforeEach(() => {
  usePlugins.setState({ items: plugins });
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      mountHostDetailsSelection: { pluginId: "sshfs", contributionId: "details" },
    },
  });
  usePluginSecurity.setState((state) => ({
    state: {
      ...state.state,
      restricted: false,
      grants: Object.fromEntries(plugins.map((p) => [p.id, p.permissions])),
    },
  }));
});
afterEach(cleanup);

it("composes ordinary sections and switches the single mount contributor for the current host", () => {
  const view = render(<HostDetailsSections hostId="host-a" />);
  expect(screen.getByText("sshfs:host-a")).toBeTruthy();
  expect(screen.getByText("notes:host-a")).toBeTruthy();
  expect(screen.queryByText("sshfs-lite:host-a")).toBeNull();
  act(() =>
    useSettings.setState((state) => ({
      settings: {
        ...state.settings,
        mountHostDetailsSelection: { pluginId: "sshfs-lite", contributionId: "details" },
      },
    })),
  );
  expect(screen.queryByText("sshfs:host-a")).toBeNull();
  expect(screen.getByText("sshfs-lite:host-a")).toBeTruthy();
  view.rerender(<HostDetailsSections hostId="host-b" />);
  expect(screen.queryByText("sshfs-lite:host-a")).toBeNull();
  expect(screen.getByText("sshfs-lite:host-b")).toBeTruthy();
});

it("unmounts revoked, stopped and restricted contributions", () => {
  render(<HostDetailsSections hostId="host-a" />);
  act(() =>
    usePluginSecurity.setState((state) => ({
      state: { ...state.state, grants: { notes: plugins[2]!.permissions } },
    })),
  );
  expect(screen.queryByText("sshfs:host-a")).toBeNull();
  expect(screen.getByText("notes:host-a")).toBeTruthy();
  act(() => usePlugins.setState({ items: plugins.map((p) => ({ ...p, status: "stopped" })) }));
  expect(screen.queryByText("notes:host-a")).toBeNull();
  act(() => usePlugins.setState({ items: plugins }));
  act(() =>
    usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: true } })),
  );
  expect(screen.queryByText("notes:host-a")).toBeNull();
});
