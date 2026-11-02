import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real pane layout, tab handlers and workspace store. Surrounding
// panels do not participate in workspace drag routing.
vi.mock("@/components/layout/HostTree", () => ({
  HostTree: () => <input aria-label="Host view search" defaultValue="" />,
}));
vi.mock("@/features/settings/TrustedHostsSidebar", () => ({
  TrustedHostsSidebar: () => <input aria-label="Trusted view search" defaultValue="" />,
}));
vi.mock("@/features/plugins/PluginsSidebar", () => ({
  PluginsSidebar: () => <input aria-label="Plugin view search" defaultValue="" />,
}));
vi.mock("@/components/layout/CommandPalette", () => ({
  CommandPalette: ({ open }: { open: boolean }) =>
    open ? <div data-testid="command-palette" /> : null,
}));
vi.mock("@/components/layout/ActivityBar", () => ({ ActivityBar: () => null }));
vi.mock("@/components/layout/RemotePanel", () => ({ RemotePanel: () => null }));
vi.mock("@/components/layout/StatusBar", () => ({
  StatusBar: () => <footer data-testid="statusbar" />,
}));
vi.mock("@/components/layout/SystemPanel", () => ({ SystemPanel: () => null }));
vi.mock("@/components/ui/overlay/Toast", () => ({ ToastHost: () => null }));
vi.mock("@/components/ui/overlay/ContextMenu", () => ({ ContextMenuHost: () => null }));
vi.mock("@/features/dialogs/DialogHost", () => ({ DialogHost: () => null }));
vi.mock("@/components/layout/TabContent", () => ({
  TabContent: () => null,
  WorkspaceContents: () => null,
}));

import { AppShell } from "@/components/layout/AppShell";
import { TAB_MIME } from "@/components/layout/PaneView";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function drag(target: Element, type: "dragover" | "drop", x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = {
    types: [TAB_MIME],
    getData: (format: string) => (format === TAB_MIME ? "terminal:b" : ""),
    dropEffect: "none",
  };
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: { value: transfer },
  });
  fireEvent(target, event);
  return { event, transfer };
}

function renderWorkspace() {
  const rendered = render(<AppShell />);
  const workspace = rendered.container.querySelector(".workspace")!;
  vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(rectangle(100, 50, 800, 600));
  const strips = [...workspace.querySelectorAll(".pane__header")];
  const bodies = [...workspace.querySelectorAll(".pane__body")];
  strips.forEach((strip, index) => {
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(
      rectangle(100 + index * 400, 50, 400, 34),
    );
  });
  bodies.forEach((body, index) => {
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
      rectangle(100 + index * 400, 84, 400, 566),
    );
  });
  const first = workspace.querySelector('[data-tab-id="terminal:a"]')!;
  const second = workspace.querySelector('[data-tab-id="terminal:b"]')!;
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rectangle(100, 50, 120, 34));
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rectangle(220, 50, 120, 34));
  return { workspace, first, bodies };
}

beforeEach(() => {
  useDialogs.getState().close();
  useSettings.setState({ settings: DEFAULT_SETTINGS, update: vi.fn().mockResolvedValue(true) });
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: true,
    visitedSidebars: ["hosts"],
  });
  useWorkspace.setState({
    tabs: [
      { id: "terminal:a", kind: "terminal", title: "A", hostId: "a", pinned: false },
      { id: "terminal:b", kind: "terminal", title: "B", hostId: "b", pinned: false },
      { id: "terminal:c", kind: "terminal", title: "C", hostId: "c", pinned: false },
    ],
    panes: [
      { id: "pane-1", tabIds: ["terminal:a", "terminal:b"], activeId: "terminal:a" },
      { id: "pane-2", tabIds: ["terminal:c"], activeId: "terminal:c" },
    ],
    activePaneId: "pane-1",
    activeId: "terminal:a",
    split: "row",
    layout: {
      kind: "split",
      id: "initial-split",
      direction: "row",
      ratio: 0.5,
      first: { kind: "pane", paneId: "pane-1" },
      second: { kind: "pane", paneId: "pane-2" },
    },
  });
});

describe("AppShell terminal shortcut ownership", () => {
  function terminal() {
    const { container } = render(<AppShell />);
    const host = document.createElement("div");
    host.className = "terminal-host";
    const input = document.createElement("textarea");
    host.append(input);
    container.append(host);
    return input;
  }

  it.each([
    { key: ",", ctrlKey: true },
    { key: "，", code: "Comma", ctrlKey: true },
    { key: "，", code: "Comma", metaKey: true },
  ])("opens settings before xterm receives the comma shortcut (%j)", (options) => {
    const input = terminal();
    const xterm = vi.fn();
    input.addEventListener("keydown", xterm);
    fireEvent.keyDown(input, options);
    expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "settings")).toBe(true);
    expect(xterm).not.toHaveBeenCalled();
  });

  it("opens settings from a normal input while preserving typing and editing shortcuts", () => {
    const { container } = render(<AppShell />);
    const input = document.createElement("input");
    container.append(input);
    fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    expect(useDialogs.getState().dialog.kind).toBe("none");
    fireEvent.keyDown(input, { key: "，", code: "Comma", ctrlKey: true });
    expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "settings")).toBe(true);
  });

  it("uses customized global shortcuts immediately and disables the previous default", () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, keyboardShortcuts: { "page.settings": ["Mod+Shift+Y"] } },
    });
    const input = terminal();
    fireEvent.keyDown(input, { key: ",", ctrlKey: true });
    expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "settings")).toBe(false);
    fireEvent.keyDown(input, { key: "Y", ctrlKey: true, shiftKey: true });
    expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "settings")).toBe(true);
  });

  it("passes shell editing, tmux, SIGQUIT, remote control chords and AltGr through", () => {
    const input = terminal();
    const keys: KeyboardEventInit[] = [
      ...["k", "n", "b", "w", "\\", "1", "2"].map((key) => ({ key })),
      { key: "K", shiftKey: true },
      { key: "|", shiftKey: true },
      { key: "n", altKey: true },
      { key: "1", altKey: true },
    ];
    for (const key of keys) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        ...key,
      });
      fireEvent(input, event);
      expect(event.defaultPrevented, `Ctrl chord ${key.key}`).toBe(false);
    }
    expect(useWorkspace.getState().tabs).toHaveLength(3);
    expect(useWorkspace.getState().panes).toHaveLength(2);
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(useDialogs.getState().dialog.kind).toBe("none");
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("keeps deliberate workspace commands available from the terminal", () => {
    const input = terminal();
    fireEvent.keyDown(input, { key: "Tab", ctrlKey: true });
    expect(useWorkspace.getState().activeId).toBe("terminal:b");
    fireEvent.keyDown(input, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(useWorkspace.getState().activeId).toBe("terminal:a");
    fireEvent.keyDown(input, { key: "+", ctrlKey: true });
    expect(useSettings.getState().update).toHaveBeenCalledWith({ monoFontSize: 15 });
    fireEvent.keyDown(input, { key: "N", ctrlKey: true, shiftKey: true });
    expect(useDialogs.getState().dialog.kind).toBe("host");
    useDialogs.getState().close();
    fireEvent.keyDown(input, { key: "W", ctrlKey: true, shiftKey: true });
    expect(useWorkspace.getState().panes).toHaveLength(1);
    fireEvent.keyDown(input, { key: "P", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("command-palette")).toBeTruthy();
  });

  it("routes workspace keys before xterm target capture while shell keys reach it", () => {
    const input = terminal();
    const xtermKey = vi.fn();
    input.addEventListener("keydown", xtermKey, true);
    for (const key of ["k", "n", "\\"]) {
      fireEvent.keyDown(input, { key, ctrlKey: true });
    }
    expect(xtermKey).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("command-palette")).toBeNull();

    for (const key of ["+", "-", "0"]) {
      fireEvent.keyDown(input, { key, ctrlKey: true });
    }
    expect(useSettings.getState().update).toHaveBeenCalledTimes(2);
    expect(xtermKey).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(input, { key: "P", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    expect(xtermKey).toHaveBeenCalledTimes(3);
  });

  it("keeps macOS Command workspace bindings while Control remains available to SSH", () => {
    const input = terminal();
    fireEvent.keyDown(input, { key: "b", metaKey: true });
    expect(useNavigation.getState().sidebarVisible).toBe(false);
    fireEvent.keyDown(input, { key: "w", metaKey: true });
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).not.toContain("terminal:a");
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    expect(screen.getByTestId("command-palette")).toBeTruthy();
  });
});

describe("AppShell side view persistence", () => {
  it("removes the status row live while keeping the workspace mounted", () => {
    const { container } = render(<AppShell />);
    const workspace = container.querySelector(".workspace");
    expect(screen.getByTestId("statusbar")).toBeTruthy();
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, showStatusBar: false } }));
    expect(screen.queryByTestId("statusbar")).toBeNull();
    expect(container.querySelector(".app")?.classList.contains("is-statusbar-hidden")).toBe(true);
    expect(container.querySelector(".workspace")).toBe(workspace);
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS }));
    expect(screen.getByTestId("statusbar")).toBeTruthy();
  });

  it("uses the new font bounds and resets to the application default", () => {
    render(<AppShell />);
    const update = useSettings.getState().update;
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monoFontSize: 31 } }));
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(update).toHaveBeenLastCalledWith({ monoFontSize: 32 });
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, monoFontSize: 11 } }));
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(update).toHaveBeenLastCalledWith({ monoFontSize: 10 });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(update).toHaveBeenLastCalledWith({ monoFontSize: 14 });
  });
  it("lazily mounts side views and retains their DOM state when switching and collapsing", () => {
    const { container } = render(<AppShell />);
    const hosts = screen.getByRole("textbox", { name: "Host view search" });
    fireEvent.change(hosts, { target: { value: "production" } });
    expect(screen.queryByRole("textbox", { name: "Plugin view search" })).toBeNull();
    act(() => useNavigation.getState().selectSidebar("plugins"));
    const plugins = screen.getByRole("textbox", { name: "Plugin view search" });
    fireEvent.change(plugins, { target: { value: "theme" } });
    expect(container.querySelector("#sidebar-hosts")?.hasAttribute("hidden")).toBe(true);
    act(() => useNavigation.getState().selectSidebar("hosts"));
    expect(screen.getByRole("textbox", { name: "Host view search" })).toBe(hosts);
    expect((hosts as HTMLInputElement).value).toBe("production");
    act(() => useNavigation.getState().selectSidebar("plugins"));
    expect(screen.getByRole("textbox", { name: "Plugin view search" })).toBe(plugins);
    expect((plugins as HTMLInputElement).value).toBe("theme");
    const terminal = document.createElement("div");
    terminal.className = "terminal-host";
    container.appendChild(terminal);
    fireEvent.keyDown(terminal, { key: "b", ctrlKey: true });
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    terminal.remove();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useNavigation.getState().sidebarVisible).toBe(false);
    expect(container.querySelector("#sidebar-plugins")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector('[aria-label="Sidebar width"]')).toBeNull();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Plugin view search" })).toBe(plugins);
    expect((plugins as HTMLInputElement).value).toBe("theme");
  });
});

describe("AppShell workspace drag routing", () => {
  it("lets a tab strip reorder tabs even where it overlaps the root edge zone", () => {
    const { first } = renderWorkspace();
    const label = first.querySelector(".td-tab__label")!;
    // This point is within both the workspace's left/top edge regions.
    const over = drag(label, "dragover", 120, 65);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe("move");
    expect(first.classList.contains("is-drop-before")).toBe(true);
    drag(label, "drop", 120, 65);
    expect(useWorkspace.getState().panes).toHaveLength(2);
    expect(useWorkspace.getState().panes[0]?.tabIds).toEqual(["terminal:b", "terminal:a"]);
    expect(useWorkspace.getState().layout).toMatchObject({
      id: "initial-split",
      direction: "row",
    });
  });

  it("captures a workspace edge drop to split the entire layout", () => {
    const { bodies } = renderWorkspace();
    const target = bodies[1]!;
    const over = drag(target, "dragover", 700, 100);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe("move");
    drag(target, "drop", 700, 100);
    const state = useWorkspace.getState();
    const newPane = state.panes.find((pane) => pane.tabIds.includes("terminal:b"))!;
    expect(state.panes).toHaveLength(3);
    expect(state.layout).toMatchObject({
      kind: "split",
      direction: "column",
      first: { kind: "pane", paneId: newPane.id },
      second: { kind: "split", id: "initial-split", direction: "row" },
    });
  });

  it("leaves a pane's center drop to that pane without creating a root split", () => {
    const { bodies } = renderWorkspace();
    const target = bodies[1]!;
    const over = drag(target, "dragover", 700, 350);
    expect(over.event.defaultPrevented).toBe(true);
    drag(target, "drop", 700, 350);
    const state = useWorkspace.getState();
    expect(state.panes).toHaveLength(2);
    expect(state.panes.find((pane) => pane.id === "pane-1")?.tabIds).toEqual(["terminal:a"]);
    expect(state.panes.find((pane) => pane.id === "pane-2")?.tabIds).toEqual([
      "terminal:c",
      "terminal:b",
    ]);
    expect(state.layout).toMatchObject({ id: "initial-split", direction: "row" });
  });
});
