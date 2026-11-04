import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/layout/TabContent", () => ({ TabContent: () => null }));

import "@/i18n/i18n";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useContextMenu } from "@/store/contextMenu";

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useWorkspace.setState({
    tabs: ["a", "b", "c"].map((id) => ({
      id,
      kind: "terminal",
      title: id.toUpperCase(),
      hostId: id,
      pinned: false,
    })),
    panes: [
      { id: "first", tabIds: ["a", "b"], activeId: "a" },
      { id: "second", tabIds: ["c"], activeId: "c" },
    ],
    activePaneId: "first",
    activeId: "a",
    split: "row",
    layout: {
      kind: "split",
      id: "split",
      direction: "row",
      ratio: 0.5,
      first: { kind: "pane", paneId: "first" },
      second: { kind: "pane", paneId: "second" },
    },
  });
});

describe("workspace group actions", () => {
  it("marks navigation previews and keeps them open by double click or context menu", () => {
    useWorkspace.getState().openPage("settings");
    render(<PaneLayout />);
    const tab = screen.getByRole("tab", { name: "Settings" });
    expect(tab.classList.contains("is-preview")).toBe(true);
    fireEvent.doubleClick(tab);
    expect(tab.classList.contains("is-preview")).toBe(false);
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === "page:settings")?.pinned).toBe(
      false,
    );
    act(() => useWorkspace.getState().openPage("about"));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "About" }));
    // The action is available independently of the old pinned-tab behavior.
    const action = useContextMenu.getState().menu?.items.find((item) => item.label === "Keep open");
    act(() => action?.onSelect?.());
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === "page:about")?.preview).toBe(
      false,
    );
  });
  it("marks the locked destination and routes a new page there after another pane is focused", () => {
    const { container } = render(<PaneLayout />);
    const first = container.querySelector('[data-pane-id="first"]') as HTMLElement;
    fireEvent.click(
      within(first).getByRole("button", { name: "Lock as the default pane for new pages" }),
    );
    expect(
      within(first)
        .getByRole("button", { name: "Unlock the default pane for new pages" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "C" }));
    act(() => {
      useWorkspace.getState().openPage("settings");
    });
    expect(useWorkspace.getState().panes.find((pane) => pane.id === "first")?.tabIds).toContain(
      "page:settings",
    );
  });

  it("offers all tabs in the More menu so overflow tabs remain reachable", () => {
    const { container } = render(<PaneLayout />);
    fireEvent.click(
      within(container.querySelector('[data-pane-id="first"]') as HTMLElement).getByRole("button", {
        name: "More",
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "B" }));
    expect(useWorkspace.getState().activeId).toBe("b");
  });

  it("keeps group actions outside the scrolling tablist and exposes group close through More", () => {
    const { container } = render(<PaneLayout />);
    const headers = [...container.querySelectorAll<HTMLElement>(".pane__header")];
    expect(headers).toHaveLength(2);
    expect(container.querySelector(".pane__tabs-close")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
    for (const header of headers) {
      const tabs = within(header).getByRole("tablist");
      const more = within(header).getByRole("button", { name: "More" });
      expect(tabs.contains(more)).toBe(false);
      expect(within(tabs).getAllByRole("button", { name: "Close tab" })).toHaveLength(
        header === headers[0] ? 2 : 1,
      );
    }
    expect(within(headers[1]!).queryByRole("button", { name: "Split right" })).toBeNull();
    fireEvent.click(within(headers[1]!).getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Close pane" })).toBeTruthy();
    expect(
      (screen.getByRole("menuitem", { name: "Split right" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("closing a group preserves its tabs and returns focus to the surviving group", async () => {
    const { container } = render(<PaneLayout />);
    const header = container.querySelectorAll<HTMLElement>(".pane__header")[1]!;
    fireEvent.click(within(header).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close pane" }));
    expect(useWorkspace.getState().panes).toHaveLength(1);
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
    expect(useWorkspace.getState().panes[0]!.tabIds).toEqual(["a", "b", "c"]);
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.tabId).toBe("a"));
  });

  it("splits the active tab and focuses its new group", async () => {
    render(<PaneLayout />);
    fireEvent.click(screen.getByRole("button", { name: "Split right" }));
    expect(useWorkspace.getState().panes).toHaveLength(3);
    expect(useWorkspace.getState().panes.find((pane) => pane.id === "first")?.tabIds).toEqual([
      "b",
    ]);
    expect(useWorkspace.getState().activeId).toBe("a");
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.tabId).toBe("a"));
  });

  it("keeps Close tab distinct from closing a group", () => {
    render(<PaneLayout />);
    fireEvent.click(
      within(screen.getByRole("tab", { name: "C" })).getByRole("button", {
        name: "Close tab",
      }),
    );
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(useWorkspace.getState().panes).toHaveLength(1);
  });

  it("keeps sidebar movement reachable from the group menu when its inner title is omitted", () => {
    const id = "sidebar:hosts";
    useWorkspace.setState({
      tabs: [{ id, kind: "sidebar", title: "Hosts", hostId: null, pinned: false }],
      panes: [{ id: "first", tabIds: [id], activeId: id }],
      activePaneId: "first",
      activeId: id,
      split: null,
      layout: { kind: "pane", paneId: "first" },
    });
    render(<PaneLayout />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Move to the left" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to side bar" }));
    expect(useWorkspace.getState().tabs.some((tab) => tab.id === id)).toBe(false);
  });
});
