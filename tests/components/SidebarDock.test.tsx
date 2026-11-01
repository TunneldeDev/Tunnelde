import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { SidebarArea, SidebarContents } from "@/components/layout/SidebarDock";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { useNavigation } from "@/store/navigation";
import { useWorkspace, workspaceRecords } from "@/store/workspace";
import { SIDEBAR_MIME, TAB_MIME } from "@/lib/session/sidebarDock";
vi.mock("@/features/terminal/TerminalPage", () => ({ TerminalPage: () => null }));

const { mounted, unmounted } = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock("@/components/layout/HostTree", () => ({ HostTree: () => <List view="hosts" /> }));
vi.mock("@/features/plugins/PluginsSidebar", () => ({
  PluginsSidebar: () => <List view="plugins" />,
}));
vi.mock("@/features/settings/TrustedHostsSidebar", () => ({
  TrustedHostsSidebar: () => <List view="knownHosts" />,
}));
vi.mock("@/features/welcome/WelcomePage", () => ({ WelcomePage: () => <div>Workspace page</div> }));

function List({ view }: { view: "hosts" | "plugins" | "knownHosts" }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    mounted(view);
    return () => {
      unmounted(view);
    };
  }, [view]);
  return (
    <section className="sidebar">
      <header>
        <SidebarTitle view={view}>{view}</SidebarTitle>
        <SidebarDockControls view={view} />
      </header>
      <input
        aria-label={`${view} search`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </section>
  );
}

function Shell() {
  return (
    <>
      <ActivityBar />
      <SidebarArea />
      <SidebarContents />
      <PaneLayout />
      <WorkspaceContents />
    </>
  );
}
function transfer(id = "sidebar:hosts") {
  const data = new Map([
    [TAB_MIME, id],
    [SIDEBAR_MIME, id.slice(8)],
  ]);
  return {
    types: [...data.keys()],
    getData: (key: string) => data.get(key) ?? "",
    setData: (key: string, value: string) => {
      data.set(key, value);
    },
    effectAllowed: "move",
    dropEffect: "none",
  };
}
function drop(target: Element, x: number, y: number, id = "sidebar:hosts") {
  const event = createEvent.drop(target, { dataTransfer: transfer(id) });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
  fireEvent(target, event);
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: true,
    visitedSidebars: ["hosts"],
  });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
  useWorkspace.getState().openPage("welcome");
});

describe("sidebar panel docking", () => {
  it("leaves the sidebar in place when dragging its title is cancelled", () => {
    const view = render(<Shell />);
    const title = view.container.querySelector(".sidebar-drag-title")!;
    const data = transfer();
    fireEvent.dragStart(title, { dataTransfer: data });
    expect(data.getData(TAB_MIME)).toBe("sidebar:hosts");
    expect(data.getData(SIDEBAR_MIME)).toBe("hosts");
    fireEvent.dragEnd(title, { dataTransfer: data });
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toEqual(["welcome"]);
    expect(
      screen.getByRole("textbox", { name: "hosts search" }).closest(".sidebar-view"),
    ).toBeTruthy();
  });

  it("docks into a tab strip and returns through the activity bar with the same list and search state", () => {
    const view = render(<Shell />);
    const input = screen.getByRole("textbox", { name: "hosts search" });
    fireEvent.change(input, { target: { value: "production" } });
    drop(view.container.querySelector(".pane__tabs")!, 150, 15);
    expect(input.closest('[data-docked="true"]')).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "hosts search" })).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Hosts" }));
    expect(useWorkspace.getState().tabs.filter((tab) => tab.kind === "sidebar")).toHaveLength(1);
    drop(screen.getByRole("navigation", { name: "Workspace" }), 20, 60);
    expect(input.closest(".sidebar-view")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("production");
    expect(mounted).toHaveBeenCalledExactlyOnceWith("hosts");
    expect(unmounted).not.toHaveBeenCalled();
  });

  it.each([
    ["left", 10, 200, "row", "first"],
    ["right", 490, 200, "row", "second"],
    ["top", 250, 10, "column", "first"],
    ["bottom", 250, 390, "column", "second"],
  ] as const)(
    "drops a sidebar at the %s edge of an existing pane",
    (_edge, x, y, direction, side) => {
      const view = render(<Shell />);
      const body = view.container.querySelector(".pane__body")!;
      vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 500,
        height: 400,
        right: 500,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      drop(body, x, y);
      const state = useWorkspace.getState();
      expect(state.panes).toHaveLength(2);
      expect(state.layout.kind).toBe("split");
      if (state.layout.kind !== "split") throw Error("Expected split");
      expect(state.layout.direction).toBe(direction);
      const owner = state.panes.find((pane) => pane.tabIds.includes("sidebar:hosts"))!;
      expect(state.layout[side]).toEqual({ kind: "pane", paneId: owner.id });
      expect(
        screen.getByRole("textbox", { name: "hosts search" }).closest('[data-docked="true"]'),
      ).toBeTruthy();
      expect(mounted).toHaveBeenCalledTimes(1);
      expect(unmounted).not.toHaveBeenCalled();
    },
  );

  it("offers keyboard reachable move commands and restores a closed panel to the sidebar", () => {
    render(<Shell />);
    const input = screen.getByRole("textbox", { name: "hosts search" });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("docking.moveToWorkspace") }));
    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("docking.moveBottom") }));
    expect(useWorkspace.getState().split).toBe("column");
    act(() => useWorkspace.getState().close("sidebar:hosts"));
    expect(screen.getByRole("textbox", { name: "hosts search" })).toBe(input);
    expect(input.closest(".sidebar-view")).toBeTruthy();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("preserves plugin list state through pane moves and a return to the sidebar", () => {
    render(<Shell />);
    act(() => useNavigation.getState().showSidebar("plugins"));
    const input = screen.getByRole("textbox", { name: "plugins search" });
    fireEvent.change(input, { target: { value: "palette" } });
    act(() => useWorkspace.getState().splitTab("sidebar:plugins", "row", "after", "pane-1"));
    act(() => useWorkspace.getState().moveTab("sidebar:plugins", "pane-1"));
    act(() => useWorkspace.getState().returnSidebar("plugins"));
    expect(screen.getByRole("textbox", { name: "plugins search" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("palette");
    expect(mounted.mock.calls.filter(([name]) => name === "plugins")).toHaveLength(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("routes a drop over another sidebar's portal content back to the original list", () => {
    render(<Shell />);
    act(() => useWorkspace.getState().splitTab("sidebar:plugins", "row", "after", "pane-1"));
    const plugin = screen.getByRole("textbox", { name: "plugins search" });
    drop(screen.getByRole("textbox", { name: "hosts search" }), 20, 90, "sidebar:plugins");
    expect(useWorkspace.getState().tabs.some((tab) => tab.id === "sidebar:plugins")).toBe(false);
    expect(useNavigation.getState().activeSidebar).toBe("plugins");
    expect(screen.getByRole("textbox", { name: "plugins search" })).toBe(plugin);
    expect(plugin.closest(".sidebar-view")).toBeTruthy();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("restores a docked list at startup without creating another sidebar instance", () => {
    useWorkspace.getState().splitTab("sidebar:plugins", "column", "after", "pane-1");
    const records = workspaceRecords();
    useNavigation.setState({
      activeSidebar: "hosts",
      sidebarVisible: true,
      visitedSidebars: ["hosts"],
    });
    useWorkspace.getState().hydrate(records);
    render(<Shell />);
    expect(
      screen.getByRole("textbox", { name: "plugins search" }).closest('[data-docked="true"]'),
    ).toBeTruthy();
    expect(document.querySelectorAll('[data-sidebar-panel="plugins"]')).toHaveLength(1);
    expect(mounted.mock.calls.filter(([name]) => name === "plugins")).toHaveLength(1);
    expect(unmounted).not.toHaveBeenCalled();
  });
});
