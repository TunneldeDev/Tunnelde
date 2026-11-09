import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { useHostDecorations } from "@/store/hostDecorations";
import { usePlugins } from "@/store/plugins";
import { plugin } from "../fixtures/plugins";
import { indexHostDecorations } from "@/lib/plugins/hostList";
import { HostTree } from "@/components/layout/HostTree";
import type { Group, Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useContextMenu } from "@/store/contextMenu";
import { ContextMenuHost } from "@/components/ui/overlay/ContextMenu";
import { connectHostDirectly } from "@/lib/session/connectHost";

vi.mock("@/lib/session/connectHost", () => ({ connectHostDirectly: vi.fn(async () => undefined) }));

const host = (id: string, name: string, sortOrder: number): Host => ({
  id,
  groupId: null,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
});
const openHostDetails = useWorkspace.getState().openHost;
const group = (id: string, parentId: string | null = null): Group => ({
  id,
  name: id,
  parentId,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  usePlugins.setState({ items: [] });
  useHostDecorations.setState({ revision: -1, byHost: new Map() });
  useContextMenu.setState({ menu: null });
  useHosts.setState({ hosts: [host("a", "alpha", 0), host("b", "beta", 1)], groups: [] });
  useDialogs.setState({
    openHost: vi.fn(),
    openGroup: vi.fn(),
    openConnect: vi.fn(),
    confirm: vi.fn(),
  });
  vi.mocked(connectHostDirectly).mockClear();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hostDirectConnect: false } });
  useWorkspace.setState({
    openHost: openHostDetails,
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
  });
});

describe("HostTree keyboard navigation", () => {
  it("adds attributed plugin actions to both pointer and more menus and removes them on uninstall", () => {
    const contribution = {
      ...plugin,
      commands: [{ id: "inspect", title: "Inspect host", hostMenu: true }],
      permissions: ["hosts.read"],
    };
    usePlugins.setState({ items: [contribution] });
    render(
      <>
        <HostTree />
        <ContextMenuHost />
      </>,
    );
    const row = screen.getAllByRole("treeitem")[0]!;
    fireEvent.contextMenu(row);
    const action = screen.getByRole("menuitem", { name: "Inspect host" });
    expect(action.textContent).toContain(plugin.name);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(row.querySelector("button")!);
    expect(screen.getByRole("menuitem", { name: "Inspect host" })).toBeTruthy();
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.queryByRole("menuitem", { name: "Inspect host" })).toBeNull();
  });
  it("renders hosts at every group depth and counts all descendants", () => {
    useHosts.setState({
      groups: [
        group("Root"),
        group("Child", "Root"),
        group("Grandchild", "Child"),
        group("Leaf", "Grandchild"),
      ],
      hosts: [
        { ...host("deep", "Deep host", 0), groupId: "Leaf" },
        { ...host("root", "Root host", 1), groupId: "Root" },
      ],
    });
    render(<HostTree />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    for (const name of ["Root", "Child", "Grandchild", "Leaf"]) {
      const row = screen.getByRole("button", { name: new RegExp(`^${name} `) });
      expect(row.querySelector(".group-row__count")?.textContent).toBe(name === "Root" ? "2" : "1");
    }
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "End" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-deep");
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(useWorkspace.getState().tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostId: "deep" })]),
    );
  });

  it("reveals deep search matches while preserving normal collapsed groups", () => {
    useHosts.setState({
      groups: [group("Root"), group("Child", "Root"), group("Leaf", "Child"), group("Unrelated")],
      hosts: [{ ...host("deep", "Deep host", 0), groupId: "Leaf", tags: ["production"] }],
    });
    render(<HostTree />);
    fireEvent.click(screen.getByRole("button", { name: /^Root / }));
    expect(screen.queryByRole("treeitem")).toBeNull();
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "@tag:production" } });
    expect(screen.getByRole("treeitem").textContent).toContain("Deep host");
    expect(screen.queryByRole("button", { name: /^Unrelated / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Child / }));
    expect(screen.queryByRole("treeitem")).toBeNull();
    fireEvent.change(search, { target: { value: "Deep" } });
    expect(screen.getByRole("treeitem")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: /^Root / }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByRole("treeitem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Root / }));
    expect(screen.getByRole("treeitem")).toBeTruthy();
    fireEvent.change(search, { target: { value: "@tag:production" } });
    expect(screen.getByRole("treeitem")).toBeTruthy();
  });

  it("keeps hosts reachable when imported groups have missing or cyclic parents", () => {
    useHosts.setState({
      groups: [
        group("Orphan", "missing"),
        group("Cycle A", "Cycle B"),
        group("Cycle B", "Cycle A"),
      ],
      hosts: [
        { ...host("orphan", "Orphan host", 0), groupId: "Orphan" },
        { ...host("cycle", "Cycle host", 1), groupId: "Cycle B" },
        { ...host("missing", "Missing group host", 2), groupId: "missing" },
      ],
    });
    render(<HostTree />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /^Cycle A / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cycle B / })).toBeTruthy();
  });

  it("clears a hidden keyboard target when its ancestor is collapsed", () => {
    useHosts.setState({
      groups: [group("Root"), group("Child", "Root"), group("Leaf", "Child")],
      hosts: [
        { ...host("deep", "Deep host", 0), groupId: "Leaf" },
        host("ungrouped", "Ungrouped host", 1),
      ],
    });
    render(<HostTree />);
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-deep");
    fireEvent.click(screen.getByRole("button", { name: /^Child / }));
    expect(tree.hasAttribute("aria-activedescendant")).toBe(false);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(useWorkspace.getState().tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostId: "ungrouped" })]),
    );
  });

  it("keeps tags in search suggestions and supports @tag filtering and one-click clear", () => {
    useHosts.setState({
      hosts: [
        { ...host("a", "alpha", 0), tags: ["PublicNet"] },
        { ...host("b", "beta", 1), tags: ["private"] },
      ],
    });
    const { container } = render(<HostTree />);
    expect(container.querySelector(".sidebar__tags")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    const input = screen.getByRole("combobox", { name: "Search hosts" });
    fireEvent.focus(input);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "@tag:PublicNet" } });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(screen.getByRole("treeitem").textContent).toContain("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Clear host search" }));
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  });

  it("completes tags by keyboard, combines them with text, and dismisses suggestions with Escape", () => {
    useHosts.setState({
      hosts: [
        { ...host("a", "alpha", 0), tags: ["PublicNet"] },
        { ...host("b", "beta", 1), tags: ["PublicNet"] },
      ],
    });
    render(<HostTree />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "alpha @tag:Pub" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((input as HTMLInputElement).value).toBe("alpha @tag:PublicNet ");
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "@tag:Pub" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("@tag:Pub");
  });

  it("keeps creation actions in the header and search below without repeating app branding", () => {
    const { container } = render(<HostTree />);
    const toolbar = screen.getByRole("toolbar", { name: "Hosts" });
    expect(toolbar.contains(screen.getByRole("combobox"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "New host" }));
    expect(useDialogs.getState().openHost).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    expect(useDialogs.getState().openGroup).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Tunnelde")).toBeNull();
    expect(container.querySelector(".sidebar__foot")).toBeNull();
  });

  it("moves the active row with the arrow keys and opens it with Enter", () => {
    render(<HostTree />);

    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-a");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-b");

    fireEvent.keyDown(tree, { key: "Enter" });
    expect(useWorkspace.getState().tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "host", hostId: "b" })]),
    );
    expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
  });

  it("wraps to the last row when nothing is selected yet", () => {
    render(<HostTree />);
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-b");

    fireEvent.keyDown(tree, { key: "Home" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-a");
  });

  it("disables drag reordering when the list is filtered", () => {
    render(<HostTree />);
    expect(
      screen.getAllByRole("treeitem").every((row) => row.getAttribute("draggable") === "true"),
    ).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "alpha" } });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(screen.getByRole("treeitem").getAttribute("draggable")).toBe("false");
  });

  it("scrolls the keyboard target into view", () => {
    const scroll = vi.fn();
    render(<HostTree />);
    const rows = screen.getAllByRole("treeitem");
    rows[1]!.scrollIntoView = scroll;
    fireEvent.keyDown(screen.getByRole("tree"), { key: "End" });
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("opens host details on a single click and connects on double click", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hostDirectConnect: false } });
    render(<HostTree />);
    const row = screen.getAllByRole("treeitem")[0]!;
    fireEvent.click(row, { detail: 1 });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "host")).toBe(true);
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    expect(useDialogs.getState().openConnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "a" }),
      "terminal",
    );
  });

  it.each(["terminal", "edit"] as const)("uses the configured %s single-click action", (action) => {
    vi.useFakeTimers();
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, hostActivation: action, hostDirectConnect: false },
    });
    render(<HostTree />);
    fireEvent.click(screen.getAllByRole("treeitem")[0]!, { detail: 1 });
    vi.advanceTimersByTime(300);
    expect(
      action === "terminal" ? useDialogs.getState().openConnect : useDialogs.getState().openHost,
    ).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancels a pending configured single-click action when double clicking", () => {
    vi.useFakeTimers();
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, hostActivation: "edit", hostDirectConnect: false },
    });
    render(<HostTree />);
    const row = screen.getAllByRole("treeitem")[0]!;
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    vi.advanceTimersByTime(300);
    expect(useDialogs.getState().openHost).not.toHaveBeenCalled();
    expect(useDialogs.getState().openConnect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not activate a host when double clicking its action button", () => {
    render(<HostTree />);
    fireEvent.doubleClick(screen.getAllByRole("button", { name: "More" })[0]!);
    expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
    expect(useWorkspace.getState().tabs).toEqual([]);
  });

  it("uses direct connection for double click and Enter when enabled", () => {
    useSettings.setState({ settings: DEFAULT_SETTINGS });
    render(<HostTree />);
    fireEvent.doubleClick(screen.getAllByRole("treeitem")[0]!);
    expect(connectHostDirectly).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "a" }),
    );
    expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
    expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "host")).toBe(true);
  });

  it("renders the same actions, icons and separators for right click and the ellipsis", () => {
    render(
      <>
        <HostTree />
        <ContextMenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getAllByRole("treeitem")[0]!, { clientX: 20, clientY: 30 });
    const actions = () =>
      screen.getAllByRole("menuitem").map((item) => ({
        label: item.getAttribute("aria-label"),
        icon: item.querySelector("svg")?.getAttribute("class") ?? null,
        separatorBefore: item.previousElementSibling?.getAttribute("role") === "separator",
      }));
    const rightClickItems = actions();
    expect(rightClickItems.some((item) => item.icon !== null)).toBe(true);
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Escape" });
    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]!);
    expect(actions()).toEqual(rightClickItems);
  });

  it("groups host actions consistently in context and ellipsis menus", () => {
    render(<HostTree />);
    fireEvent.contextMenu(screen.getAllByRole("treeitem")[0]!, { clientX: 20, clientY: 30 });
    const items = useContextMenu.getState().menu!.items;
    expect(items).toHaveLength(10);
    expect(items.flatMap((item, index) => (item.separatorBefore ? [index] : []))).toEqual([
      3, 6, 9,
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]!);
    expect(screen.getAllByRole("menuitem")).toHaveLength(10);
    expect(screen.getAllByRole("separator")).toHaveLength(3);
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
  });
});

it("decorations preserve host identity, address and actions while changes update mounted rows", () => {
  const source = {
    id: "health",
    pluginId: "plugin",
    pluginName: "Health provider",
    priority: 10,
    decorations: [
      {
        hostId: "a",
        badge: "Ready",
        description: "Healthy",
        tooltip: null,
        icon: "server" as const,
        tone: "success" as const,
      },
    ],
  };
  useHostDecorations.setState({ revision: 1, byHost: indexHostDecorations([source]) });
  const { container, rerender } = render(<HostTree />);
  const row = container.querySelector('[data-host-id="a"]')!;
  expect(row.querySelector(".host-row__name")!.textContent).toBe("alpha");
  expect(row.querySelector(".host-row__meta")!.textContent).toContain("a.example.com");
  expect(row.querySelector(".host-row__actions")).not.toBeNull();
  expect(row.querySelector(".host-decoration__badge")!.textContent).toBe("Ready");
  act(() => {
    useHostDecorations.setState({ revision: 2, byHost: new Map() });
  });
  rerender(<HostTree />);
  expect(row.querySelector(".host-decoration__badge")).toBeNull();
  expect(row.querySelector(".host-row__name")!.textContent).toBe("alpha");
});
