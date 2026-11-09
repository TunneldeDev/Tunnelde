import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostMenuCommands, hostMenuInput, runHostMenuCommand } from "@/lib/plugins/hostMenu";
import { openPluginAction } from "@/lib/plugins/actions";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useToasts } from "@/store/toasts";
import type { Host } from "@/lib/api/types";
import i18n from "@/i18n/i18n";
import { plugin } from "../fixtures/plugins";

const host: Host = {
  id: "host-a",
  name: "Production",
  host: "server.example.org",
  port: 2222,
  username: "operator",
  groupId: null,
  tags: ["prod"],
  authMethod: "key",
  keyPath: "/private/key",
  note: "internal note",
  favorite: true,
  color: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 1,
};
const tool = {
  ...plugin,
  id: "host-tool",
  status: "running" as const,
  permissions: ["hosts.read"],
  commands: [{ id: "inspect", title: "Inspect host", hostMenu: true }],
};
const action = () => hostMenuCommands([tool])[0]!;

beforeEach(() => {
  useHosts.setState({ hosts: [host] });
  useToasts.setState({ items: [] });
  usePlugins.setState({ items: [tool], outputs: {}, execute: vi.fn().mockResolvedValue({}) });
  useWorkspace.setState({ activeId: null, tabs: [], openPluginView: vi.fn() });
});

describe("host menu contributions", () => {
  it("requires executable plugins and hosts.read, with deterministic bounded composition", () => {
    for (const candidate of [
      { ...tool, permissions: [] },
      { ...tool, runtime: "theme" as const },
      { ...tool, runtime: "declarative" as const },
    ])
      expect(hostMenuCommands([candidate])).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...tool,
      id: `tool-${i}`,
      commands: Array.from({ length: 20 }, (_, j) => ({
        id: `command-${j}`,
        title: "Inspect",
        hostMenu: true,
      })),
    }));
    const actions = hostMenuCommands(many.reverse());
    expect(actions).toHaveLength(128);
    expect(actions.filter((item) => item.pluginId === "tool-0")).toHaveLength(16);
    expect(actions[0]).toMatchObject({ pluginId: "tool-0", first: true });
    expect(actions.filter((item) => item.first)).toHaveLength(1);
    expect(hostMenuCommands([{ ...tool, runtime: "frontend" }])).toHaveLength(1);
  });

  it("projects only public advisory metadata and captures the selected host after consent", async () => {
    const input = hostMenuInput(host);
    expect(input).toEqual({
      host: {
        id: host.id,
        name: host.name,
        address: host.host,
        port: 2222,
        username: "operator",
        groupId: null,
        tags: ["prod"],
      },
    });
    await runHostMenuCommand(action(), host);
    expect(vi.mocked(usePlugins.getState().execute).mock.calls[0]![2]()).toEqual(input);
    input.host.tags.push("new");
    expect(host.tags).toEqual(["prod"]);
  });

  it("does not execute deleted hosts or replaced plugin menu entries", async () => {
    const selected = action();
    useHosts.setState({ hosts: [] });
    await runHostMenuCommand(selected, host);
    expect(usePlugins.getState().execute).not.toHaveBeenCalled();
    expect(useToasts.getState().items.at(-1)?.message).toBe(i18n.t("pluginView.hostChanged"));
    useHosts.setState({ hosts: [host] });
    usePlugins.setState({ items: [{ ...tool, fingerprint: "replacement" }] });
    await runHostMenuCommand(selected, host);
    expect(usePlugins.getState().execute).not.toHaveBeenCalled();
  });

  it("rechecks host changes and plugin permission changes after the approval prompt", async () => {
    for (const invalidate of [
      () => useHosts.setState({ hosts: [{ ...host, host: "replacement.example.org" }] }),
      () => usePlugins.setState({ items: [{ ...tool, permissions: [] }] }),
    ]) {
      useHosts.setState({ hosts: [host] });
      const execute = vi.fn(async (_id: string, _command: string, input: () => unknown) => {
        invalidate();
        input();
      });
      usePlugins.setState({ items: [tool], execute });
      await runHostMenuCommand(action(), host);
      expect(execute).toHaveBeenCalledOnce();
      expect(useToasts.getState().items.at(-1)?.variant).toBe("error");
    }
  });

  it("treats declined consent as cancellation and suppresses output from a replaced plugin", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    usePlugins.setState({ items: [{ ...tool, status: "stopped" }], start });
    await runHostMenuCommand(action(), host);
    expect(start).toHaveBeenCalledOnce();
    expect(usePlugins.getState().execute).not.toHaveBeenCalled();
    expect(useToasts.getState().items).toEqual([]);
    usePlugins.setState({
      items: [tool],
      execute: vi.fn(async () => {
        usePlugins.setState({ items: [{ ...tool, fingerprint: "replacement" }] });
        return { text: "stale" };
      }),
    });
    await runHostMenuCommand(action(), host);
    expect(useWorkspace.getState().openPluginView).not.toHaveBeenCalled();
  });

  it("uses the host of the active tab for palette and shortcut commands, captured before queuing", async () => {
    await openPluginAction({ id: tool.id, command: "inspect" });
    expect(usePlugins.getState().execute).not.toHaveBeenCalled();
    expect(useToasts.getState().items.at(-1)?.message).toBe(i18n.t("pluginView.hostRequired"));
    useWorkspace.setState({
      activeId: "remote-tab",
      tabs: [{ id: "remote-tab", kind: "terminal", hostId: host.id } as never],
    });
    const pending = openPluginAction({ id: tool.id, command: "inspect" });
    useWorkspace.setState({ activeId: null });
    await pending;
    expect(vi.mocked(usePlugins.getState().execute).mock.calls[0]![2]()).toEqual(
      hostMenuInput(host),
    );
  });
});
