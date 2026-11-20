import "@/i18n/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { HostTree } from "@/components/layout/HostTree";
import { HostPanelScope } from "@/features/hosts/panel/context";
import { createHostTargetIndex, projectHost } from "@/features/hosts/panel/projection";
import { hostPanelSource } from "@/features/hosts/panel/source";
import { executeHostPanelCommand, useHostPanelDialogs } from "@/features/hosts/panel/execute";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { PanelInteractionScope } from "@/lib/panels/interaction";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { useHostTransfer } from "@/lib/hosts/transfer";
import { useHostColumns } from "@/store/hostColumns";
import { useHostDecorations } from "@/store/hostDecorations";
import { useSsh } from "@/store/ssh";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { Host, Group } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { HostPanelDialogs } from "@/features/hosts/panel/HostPanelDialogs";
import { ContextMenuHost } from "@/components/ui/overlay/ContextMenu";
import { useContextMenu } from "@/store/contextMenu";

const host = (id: string): Host => ({
  id,
  name: `Host ${id}`,
  groupId: null,
  host: `${id}.example.invalid`,
  port: 22,
  username: "qa",
  authMethod: "key",
  keyPath: "/only/display/key",
  favorite: false,
  color: null,
  tags: ["QA"],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
});
const group: Group = {
  id: "g",
  name: "Group QA",
  parentId: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};
const initialHosts = useHosts.getState(),
  initialSettings = useSettings.getState(),
  initialDialogs = useDialogs.getState(),
  initialWorkspace = useWorkspace.getState();
beforeEach(() => {
  useHosts.setState({ ...initialHosts, hosts: [host("a"), host("b")], groups: [group] });
  useSettings.setState({
    ...initialSettings,
    settings: { ...DEFAULT_SETTINGS, hostDirectConnect: false },
  });
  useDialogs.setState({ ...initialDialogs, dialog: { kind: "none" } });
  useWorkspace.setState({ ...initialWorkspace, tabs: [], activeId: null });
  usePlugins.setState({ items: [] });
  useHostColumns.setState({ columns: [] });
  useHostDecorations.setState({ byHost: new Map() });
  useSsh.setState({ connectingHostIds: [] });
  useHostTransfer.getState().close();
  useHostPanelDialogs.setState({ sshImport: false });
  useContextMenu.getState().close();
});
afterEach(() => {
  useHosts.setState(initialHosts);
  useSettings.setState(initialSettings);
  useDialogs.setState(initialDialogs);
  useWorkspace.setState(initialWorkspace);
});
it("projects only display metadata and rotates target incarnations across edits/deletion/recreation", () => {
  const injected = {
    ...host("a"),
    password: "secret",
    passphrase: "secret",
    credentials: { ref: "keychain" },
    connectionRoute: { proxyPassword: "secret" },
  };
  expect(projectHost(injected)).toEqual(host("a"));
  const index = createHostTargetIndex(),
    first = index([host("a")]).a!;
  expect(index([{ ...host("a") }]).a).toEqual(first);
  const edited = index([{ ...host("a"), host: "other.invalid" }]).a!;
  expect(edited.revision).not.toBe(first.revision);
  index([]);
  expect(index([host("a")]).a!.revision).not.toBe(first.revision);
  const data = hostPanelSource.snapshot();
  expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  expect(Object.keys(data)).not.toContain("credentials");
});
it("rejects stale target mutations, revalidates after revealing main and never edits source-owned hosts", async () => {
  const target = hostPanelSource.snapshot().hostTargets.a!;
  const favorite = vi.fn();
  useHosts.setState({ toggleFavorite: favorite });
  useHosts.setState({ hosts: [{ ...host("a"), host: "new.invalid" }] });
  await expect(executeHostPanelCommand({ operation: "favorite", host: target })).rejects.toThrow(
    "pluginView.hostChanged",
  );
  expect(favorite).not.toHaveBeenCalled();
  const current = hostPanelSource.snapshot().hostTargets.a!,
    open = vi.fn();
  useDialogs.setState({ openHost: open });
  await expect(
    executeHostPanelCommand({ operation: "edit", host: current }, async () => {
      useHosts.setState({ hosts: [] });
    }),
  ).rejects.toThrow("pluginView.hostChanged");
  expect(open).not.toHaveBeenCalled();
  useHosts.setState({
    hosts: [
      {
        ...host("a"),
        source: {
          pluginId: "source",
          pluginName: "Source",
          id: "s",
          entryId: "a",
          label: "Source",
        },
      },
    ],
  });
  await expect(
    executeHostPanelCommand({
      operation: "favorite",
      host: hostPanelSource.snapshot().hostTargets.a!,
    }),
  ).rejects.toThrow();
  expect(favorite).not.toHaveBeenCalled();
});
it("revalidates destructive confirmation after the main-owned dialog is opened", async () => {
  const target = hostPanelSource.snapshot().hostTargets.a!;
  const remove = vi.fn(async () => true);
  useHosts.setState({ deleteHost: remove });
  await executeHostPanelCommand({ operation: "delete", host: target });
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  useHosts.setState({ hosts: [{ ...host("a"), username: "different" }] });
  if (dialog.kind === "confirm")
    await expect(dialog.onConfirm()).rejects.toThrow("pluginView.hostChanged");
  expect(remove).not.toHaveBeenCalled();
});
it("uses projected hosts and bounded lease actions without hydrating writable satellite stores", async () => {
  const data = hostPanelSource.snapshot();
  useHosts.setState({ hosts: [], groups: [] });
  const action = vi.fn(async () => true),
    client = { action } as unknown as PanelWindowClient;
  const lease = { panelId: "hosts", windowId: "satellite", generation: 5 };
  render(
    <PanelInteractionScope value={{ client, lease, staged: false }}>
      <HostPanelScope data={data} requireRemote>
        <HostTree />
      </HostPanelScope>
      <ContextMenuHost />
    </PanelInteractionScope>,
  );
  expect(screen.getByText("Host a")).toBeTruthy();
  fireEvent.contextMenu(document.querySelector('[data-host-id="a"]')!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to favorites" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(lease, {
      kind: "hosts",
      command: { operation: "favorite", host: data.hostTargets.a! },
    }),
  );
  expect(useHosts.getState().hosts).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Host view and columns" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Table view" }));
  expect(action).toHaveBeenCalledWith(lease, {
    kind: "hosts",
    command: { operation: "view", view: "table" },
  });
});
it("preserves search, collapsed groups and focused row through native capture/restore", async () => {
  useHosts.setState({ hosts: [{ ...host("a"), groupId: "g" }, host("b")] });
  const data = hostPanelSource.snapshot(),
    source = createPanelViewState();
  const frame = (controller: typeof source) => (
    <PanelViewStateScope controller={controller}>
      <HostPanelScope data={data}>
        <HostTree />
      </HostPanelScope>
    </PanelViewStateScope>
  );
  const view = render(frame(source));
  fireEvent.click(screen.getByRole("button", { name: /Group QA/ }));
  const search = screen.getByRole("combobox", { name: "Search hosts" });
  fireEvent.change(search, { target: { value: "QA" } });
  fireEvent.click(screen.getByRole("button", { name: /Group QA/ }));
  const tree = screen.getByRole("tree");
  fireEvent.keyDown(tree, { key: "ArrowDown" });
  const captured = await source.captureAsync();
  expect(captured.fields).toMatchObject({
    "hosts.query": "QA",
    "hosts.collapsed": ["g"],
    "hosts.searchCollapse": { query: "QA", ids: ["g"] },
    "hosts.focus": "b",
  });
  view.unmount();
  const destination = createPanelViewState(JSON.parse(JSON.stringify(captured)));
  render(frame(destination));
  expect((screen.getByRole("combobox", { name: "Search hosts" }) as HTMLInputElement).value).toBe(
    "QA",
  );
  expect(document.querySelector('[data-host-id="a"]')).toBeNull();
  expect(screen.getByRole("tree").getAttribute("aria-activedescendant")).toBe("host-b");
});
it("keeps an import/export modal owned by main when the list is removed", async () => {
  const view = render(
    <>
      <HostPanelDialogs />
      <HostTree />
    </>,
  );
  await act(() => executeHostPanelCommand({ operation: "exportAll" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(<HostPanelDialogs />);
  expect(screen.getByRole("dialog")).toBeTruthy();
  useHostTransfer.getState().close();
});
it("refuses staged and miscomposed remote commands rather than falling back to writable main stores", async () => {
  const data = hostPanelSource.snapshot(),
    favorite = vi.fn();
  useHosts.setState({ toggleFavorite: favorite });
  const client = { action: vi.fn(async () => true) } as unknown as PanelWindowClient;
  const view = render(
    <PanelInteractionScope value={{ client, staged: true }}>
      <HostPanelScope data={data} requireRemote>
        <HostTree />
      </HostPanelScope>
      <ContextMenuHost />
    </PanelInteractionScope>,
  );
  fireEvent.contextMenu(document.querySelector('[data-host-id="a"]')!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to favorites" }));
  await act(async () => {});
  expect(client.action).not.toHaveBeenCalled();
  expect(favorite).not.toHaveBeenCalled();
  view.rerender(
    <>
      <HostPanelScope data={data} requireRemote>
        <HostTree />
      </HostPanelScope>
      <ContextMenuHost />
    </>,
  );
  fireEvent.contextMenu(document.querySelector('[data-host-id="a"]')!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to favorites" }));
  await act(async () => {});
  expect(favorite).not.toHaveBeenCalled();
});
