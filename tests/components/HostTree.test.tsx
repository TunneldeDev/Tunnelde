import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { HostTree } from "@/components/layout/HostTree";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useContextMenu } from "@/store/contextMenu";

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

beforeEach(() => {
  useContextMenu.setState({ menu: null });
  useHosts.setState({ hosts: [host("a", "alpha", 0), host("b", "beta", 1)], groups: [] });
  useDialogs.setState({
    openHost: vi.fn(),
    openGroup: vi.fn(),
    openConnect: vi.fn(),
    confirm: vi.fn(),
  });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
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
  it("keeps creation actions in the header and search below without repeating app branding", () => {
    const { container } = render(<HostTree />);
    const toolbar = screen.getByRole("toolbar", { name: "Hosts" });
    expect(toolbar.contains(screen.getByRole("textbox"))).toBe(false);
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
    expect(useDialogs.getState().openConnect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "b" }),
      "terminal",
    );
    expect(useWorkspace.getState().tabs).toEqual([]);
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
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "alpha" } });
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

  it("single click and Space only select, without opening a page or a dialog", () => {
    render(<HostTree />);
    const row = screen.getAllByRole("treeitem")[0]!;
    fireEvent.click(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.classList.contains("is-focused")).toBe(true);
    fireEvent.keyDown(screen.getByRole("tree"), { key: " " });
    expect(useWorkspace.getState().tabs).toEqual([]);
    expect(useDialogs.getState().openHost).not.toHaveBeenCalled();
    expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
  });

  it.each(["terminal", "details", "edit"] as const)(
    "uses the %s action once for double click and Enter",
    (action) => {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hostActivation: action } });
      const openDetails = vi.spyOn(useWorkspace.getState(), "openHost");
      render(<HostTree />);
      const row = screen.getAllByRole("treeitem")[0]!;
      fireEvent.click(row, { detail: 1 });
      fireEvent.click(row, { detail: 2 });
      fireEvent.doubleClick(row, { detail: 2 });
      const operation =
        action === "terminal"
          ? useDialogs.getState().openConnect
          : action === "edit"
            ? useDialogs.getState().openHost
            : openDetails;
      expect(operation).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter", repeat: true });
      expect(operation).toHaveBeenCalledTimes(2);
      if (action !== "details") expect(openDetails).not.toHaveBeenCalled();
      if (action !== "terminal") expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
      if (action !== "edit") expect(useDialogs.getState().openHost).not.toHaveBeenCalled();
      openDetails.mockRestore();
    },
  );

  it("does not activate a host when double clicking its action button", () => {
    render(<HostTree />);
    fireEvent.doubleClick(screen.getAllByRole("button", { name: "More" })[0]!);
    expect(useDialogs.getState().openConnect).not.toHaveBeenCalled();
    expect(useWorkspace.getState().tabs).toEqual([]);
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
