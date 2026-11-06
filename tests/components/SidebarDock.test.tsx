import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { SidebarArea, SidebarContents } from "@/components/layout/SidebarDock";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { useNavigation, type SidebarView } from "@/store/navigation";
import { usePlugins } from "@/store/plugins";
import { plugin } from "../fixtures/plugins";
import { useWorkspace, workspaceRecords } from "@/store/workspace";
import { useHosts } from "@/store/hosts";
import type { Host } from "@/lib/api/types";
import { SIDEBAR_MIME, TAB_MIME } from "@/lib/session/sidebarDock";
vi.mock("@/features/terminal/TerminalPage", () => ({ TerminalPage: () => null }));

const { mounted, unmounted } = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock("@/components/layout/HostTree", () => ({ HostTree: () => <List view="hosts" /> }));
vi.mock("@/features/plugins/PluginsSidebar", () => ({
  PluginsSidebar: () => <List view="plugins" />,
}));
vi.mock("@/features/plugins/PluginSidebarPanel", () => ({
  PluginSidebarPanel: ({ view }: { view: SidebarView }) => <List view={view} />,
}));
vi.mock("@/features/settings/TrustedHostsSidebar", () => ({
  TrustedHostsSidebar: () => <List view="knownHosts" />,
}));
vi.mock("@/features/welcome/WelcomePage", () => ({ WelcomePage: () => <div>Workspace page</div> }));

function List({ view }: { view: SidebarView }) {
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
  usePlugins.setState({ items: [] });
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
  it.each([
    ["left", 10, 200, "row", "first"],
    ["right", 490, 200, "row", "second"],
    ["top", 250, 10, "column", "first"],
    ["bottom", 250, 390, "column", "second"],
  ] as const)(
    "moves forwarding to the %s edge and restores its state",
    async (_edge, x, y, direction, side) => {
      useHosts.setState({ hosts: [{ id: "one", name: "Server one" }] as Host[] });
      const rendered = render(<Shell />);
      const icon = screen.getByRole("button", { name: "Port forwarding" });
      fireEvent.click(icon);
      const host = screen.getByRole("button", { name: /Server one/ });
      fireEvent.click(host);
      await act(async () => {});
      const panel = host.closest("[data-sidebar-panel]");
      const title = panel!.querySelector(".sidebar-drag-title")!;
      const data = transfer("sidebar:forwarding");
      fireEvent.dragStart(title, { dataTransfer: data });
      expect(data.getData(TAB_MIME)).toBe("sidebar:forwarding");
      const body = rendered.container.querySelector(".pane__body")!;
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
      drop(body, x, y, "sidebar:forwarding");
      const state = useWorkspace.getState();
      expect(state.layout.kind).toBe("split");
      if (state.layout.kind !== "split") throw Error("Expected split");
      expect(state.layout.direction).toBe(direction);
      const owner = state.panes.find((pane) => pane.tabIds.includes("sidebar:forwarding"))!;
      expect(state.layout[side]).toEqual({ kind: "pane", paneId: owner.id });
      expect(host.closest('[data-docked="true"]')).toBeTruthy();
      expect(host.getAttribute("aria-expanded")).toBe("true");
      const layout = state.layout;
      fireEvent.click(icon);
      expect(icon.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(icon);
      expect(screen.getByRole("button", { name: /Server one/ })).toBe(host);
      expect(host.getAttribute("aria-expanded")).toBe("true");
      expect(useWorkspace.getState().layout).toEqual(layout);
      expect(workspaceRecords().some((record) => record.id === "sidebar:forwarding")).toBe(true);
      drop(screen.getByRole("navigation", { name: "Workspace" }), 20, 60, "sidebar:forwarding");
      expect(host.closest(".sidebar-view")).toBeTruthy();
      expect(host.getAttribute("aria-expanded")).toBe("true");
    },
  );

  it("collapses and restores a docked AI panel through its activity icon while preserving its DOM, draft and split", () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          status: "running",
          views: [
            { id: "chat", title: "AI assistant", location: "sidebar", kind: "chat", icon: "bot" },
          ],
        },
      ],
    });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "AI assistant" }));
    const view = "plugin:formatter:chat";
    const input = screen.getByRole("textbox", { name: `${view} search` });
    fireEvent.change(input, { target: { value: "Keep this draft and live session" } });
    act(() => useWorkspace.getState().splitTab(`sidebar:${view}`, "row", "after", "pane-1"));
    const initial = useWorkspace.getState().layout;
    if (initial.kind === "split") act(() => useWorkspace.getState().resizeSplit(initial.id, 0.7));
    const layout = useWorkspace.getState().layout;
    const icon = screen.getByRole("button", { name: "AI assistant" });
    expect(icon.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(icon);
    expect(icon.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: `${view} search` })).toBeNull();
    expect(document.querySelectorAll(".pane")).toHaveLength(1);
    expect(useWorkspace.getState().layout).toEqual(layout);
    fireEvent.click(icon);
    expect(screen.getByRole("textbox", { name: `${view} search` })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Keep this draft and live session");
    expect(icon.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll(".pane")).toHaveLength(2);
    expect(useWorkspace.getState().layout).toEqual(layout);
    expect(mounted.mock.calls.filter(([name]) => name === view)).toHaveLength(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("discovers contributed chat sidebars and preserves their live draft when docked and restored", () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          status: "running",
          views: [
            { id: "chat", title: "AI assistant", location: "sidebar", kind: "chat", icon: "bot" },
          ],
        },
      ],
    });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "AI assistant" }));
    const view = "plugin:formatter:chat";
    const id = `sidebar:${view}`;
    const input = screen.getByRole("textbox", { name: `${view} search` });
    fireEvent.change(input, { target: { value: "Keep this conversation draft" } });
    act(() => useWorkspace.getState().splitTab(id, "column", "after", "pane-1"));
    expect(input.closest('[data-docked="true"]')).toBeTruthy();
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === id)?.title).toBe("AI assistant");
    const records = workspaceRecords();
    act(() => useWorkspace.getState().hydrate(records));
    expect(useWorkspace.getState().tabs.some((tab) => tab.id === id)).toBe(true);
    act(() => useWorkspace.getState().returnSidebar(view));
    expect(screen.getByRole("textbox", { name: `${view} search` })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Keep this conversation draft");
    expect(mounted.mock.calls.filter(([name]) => name === view)).toHaveLength(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

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
