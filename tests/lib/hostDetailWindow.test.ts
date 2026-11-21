import "@/i18n/i18n";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  hostDetailIds,
  hostDetailTabId,
  hostDetailAllowsMove,
  useHostDetailRegistrations,
  bindHostDetail,
  synchronizeHostDetails,
} from "@/features/hosts/detail/registration";
import { executeHostDetailAction } from "@/features/hosts/detail/actions";
import { hostPanelSource } from "@/features/hosts/panel/source";
import { useWorkspace } from "@/store/workspace";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { api } from "@/lib/api/ipc";
import type { Host, PluginInfo, SshSession } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
const initial = {
  w: useWorkspace.getState(),
  h: useHosts.getState(),
  s: useSettings.getState(),
  p: usePlugins.getState(),
  d: useDialogs.getState(),
  ssh: useSsh.getState(),
};
const host: Host = {
  id: "a",
  name: "Alpha",
  host: "a.invalid",
  port: 22,
  username: "dev",
  authMethod: "key",
  keyPath: "/display/key",
  groupId: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  useWorkspace.setState({ ...initial.w, tabs: [], panes: [], activeId: null });
  useHosts.setState({ ...initial.h, hosts: [host], groups: [] });
  useSettings.setState({ ...initial.s, settings: { ...initial.s.settings, uiProviders: {} } });
  usePlugins.setState({ ...initial.p, items: [] });
  useDialogs.setState({ ...initial.d, dialog: { kind: "none" } });
  useHostDetailRegistrations.setState({ entries: new Map() });
  useSsh.setState({ ...initial.ssh, sessions: [] });
});
afterEach(() => {
  useWorkspace.setState(initial.w);
  useHosts.setState(initial.h);
  useSettings.setState(initial.s);
  usePlugins.setState(initial.p);
  useDialogs.setState(initial.d);
  useSsh.setState(initial.ssh);
  useHostDetailRegistrations.setState({ entries: new Map() });
  vi.restoreAllMocks();
});
it("uses short opaque native IDs even for long discovery host identities, retires tabs and never reuses admission", () => {
  const long = { ...host, id: "discovery:" + "x".repeat(500) };
  useWorkspace.getState().openHost(long);
  const [id] = hostDetailIds();
  expect(id).toMatch(/^host-view:[\da-f-]{36}$/);
  expect(hostDetailTabId(id!)).toBe(`host:${long.id}`);
  expect(hostDetailIds()).toEqual([id]);
  useWorkspace.setState({ tabs: [] });
  expect(hostDetailIds()).toEqual([]);
  useWorkspace.getState().openHost(long);
  expect(hostDetailIds()[0]).not.toBe(id);
});
it("binds only an existing canonical host tab, gates unsupported plugin drafts and refreshes policy", async () => {
  useWorkspace.getState().openHost(host);
  const [id] = hostDetailIds();
  const control = vi.fn().mockResolvedValue({ panelId: id, windowId: "main", generation: 1 });
  const client = { control } as unknown as PanelWindowClient;
  await bindHostDetail(client, id!);
  expect(control).toHaveBeenLastCalledWith({
    action: "bindHostPage",
    panelId: id,
    hostId: "a",
    allowMove: true,
  });
  usePlugins.setState({ items: [{ id: "p", hostFields: {} } as PluginInfo] });
  expect(hostDetailAllowsMove("a")).toBe(false);
  await synchronizeHostDetails(client, {
    windows: [],
    panels: [],
    transfers: [],
    hostPages: [{ panelId: id!, allowMove: true }],
  });
  expect(control).toHaveBeenLastCalledWith({
    action: "bindHostPage",
    panelId: id,
    hostId: "a",
    allowMove: false,
  });
  usePlugins.setState({ items: [] });
  useSettings.setState({
    settings: {
      ...useSettings.getState().settings,
      uiProviders: { forwarding: { pluginId: "p", viewId: "v" } },
    },
  });
  expect(hostDetailAllowsMove("a")).toBe(false);
  useWorkspace.setState({ tabs: [] });
  await expect(bindHostDetail(client, id!)).rejects.toThrow("panel.window.staleOwner");
});
it("scopes host commands to the actual tab and rejects stale projected targets", async () => {
  useWorkspace.getState().openHost(host);
  const [id] = hostDetailIds(),
    favorite = vi.fn();
  useHosts.setState({ toggleFavorite: favorite });
  const target = hostPanelSource.snapshot().hostTargets.a!;
  const lease = { panelId: id!, windowId: "sat", generation: 2 };
  await expect(
    executeHostDetailAction(
      { ...lease, panelId: "host-view:unbound" },
      { operation: "favorite", host: target },
      async () => {},
    ),
  ).rejects.toThrow("panel.window.staleOwner");
  await executeHostDetailAction(lease, { operation: "favorite", host: target }, async () => {});
  expect(favorite).toHaveBeenCalledWith(host);
  useHosts.setState({ hosts: [{ ...host, name: "Edited" }] });
  await expect(
    executeHostDetailAction(lease, { operation: "favorite", host: target }, async () => {}),
  ).rejects.toThrow("pluginView.hostChanged");
});
it("reuses a normal existing SFTP transport, never a forwarding or mount-only session", async () => {
  useWorkspace.getState().openHost(host);
  const [id] = hostDetailIds(),
    openSftp = vi.fn();
  useWorkspace.setState({ openSftp });
  const session = { id: "normal", hostId: "a" } as SshSession;
  useSsh.setState({
    sessions: [
      { ...session, id: "forward", purpose: "forwarding" },
      { ...session, id: "mount", purpose: "mounts" },
      session,
    ],
  });
  await executeHostDetailAction(
    { panelId: id!, windowId: "sat", generation: 2 },
    { operation: "sftp", host: hostPanelSource.snapshot().hostTargets.a! },
    async () => {},
  );
  expect(openSftp).toHaveBeenCalledWith(session);
});
it("duplicates from the current canonical host and preserves its connection route", async () => {
  useWorkspace.getState().openHost(host);
  const [id] = hostDetailIds();
  const copy = { ...host, id: "copy" };
  const createHost = vi.fn().mockResolvedValue(copy),
    openHost = vi.fn();
  useHosts.setState({ createHost });
  useWorkspace.setState({ openHost });
  const route = { hops: [] };
  vi.spyOn(api, "connectionRoute").mockResolvedValue(route as never);
  const save = vi.spyOn(api, "saveConnectionRoute").mockResolvedValue(undefined as never);
  await executeHostDetailAction(
    { panelId: id!, windowId: "sat", generation: 2 },
    { operation: "duplicate", host: hostPanelSource.snapshot().hostTargets.a! },
    async () => {},
  );
  expect(createHost).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Alpha Duplicate",
      host: "a.invalid",
      keyPath: "/display/key",
    }),
  );
  expect(save).toHaveBeenCalledWith("copy", route);
  expect(openHost).toHaveBeenCalledWith(copy);
});
