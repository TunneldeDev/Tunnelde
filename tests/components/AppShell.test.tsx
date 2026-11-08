import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
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
  CommandPalette: () =>
    useQuickAccess((state) => state.query !== null) ? <div data-testid="command-palette" /> : null,
}));
vi.mock("@/components/layout/ActivityBar", () => ({ ActivityBar: () => null }));
vi.mock("@/components/layout/RemotePanel", () => ({
  RemotePanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="remote-panel">{sessionId}</div>
  ),
}));
vi.mock("@/components/layout/StatusBar", () => ({
  StatusBar: () => <footer data-testid="statusbar" />,
}));
vi.mock("@/components/layout/SystemPanel", () => ({
  SystemPanel: () => <div data-testid="system-panel" />,
}));
vi.mock("@/components/ui/overlay/Toast", () => ({ ToastHost: () => null }));
vi.mock("@/components/ui/overlay/ContextMenu", () => ({ ContextMenuHost: () => null }));
vi.mock("@/features/dialogs/DialogHost", () => ({ DialogHost: () => null }));
vi.mock("@/components/layout/TabContent", () => ({
  TabContent: () => null,
  WorkspaceContents: () => null,
}));

import { useQuickAccess } from "@/store/quickAccess";
import { AppShell } from "@/components/layout/AppShell";
import { TAB_MIME } from "@/components/layout/PaneView";
import { beginFilePaneDrag, clearFilePaneDrag, FILE_PANE_MIME } from "@/lib/session/filePaneDrag";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import * as keyboardActions from "@/lib/keyboard/actions";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo } from "@/lib/api/types";
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
  clearFilePaneDrag();
  useQuickAccess.setState({ query: null });
  usePlugins.setState({ items: [] });
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

describe("detached file panels at workspace edges", () => {
  it.each([
    { x: 110, y: 300, direction: "row", position: "first", fraction: 240 / 796 },
    { x: 890, y: 300, direction: "row", position: "second", fraction: 240 / 796 },
    { x: 500, y: 90, direction: "column", position: "first", fraction: 180 / 596 },
    { x: 500, y: 640, direction: "column", position: "second", fraction: 180 / 596 },
  ])("docks at $position/$direction with the original file-panel size", (test) => {
    const { workspace, bodies } = renderWorkspace();
    const onMoved = vi.fn();
    const token = beginFilePaneDrag(
      { source: { kind: "local" }, path: "C:\\work", ownerSessionId: "s1" },
      "This computer",
      onMoved,
      { width: 240, height: 180 },
    );
    const transfer = {
      types: [FILE_PANE_MIME],
      getData: (format: string) => (format === FILE_PANE_MIME ? token : ""),
      dropEffect: "none",
    };
    const send = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: test.x },
        clientY: { value: test.y },
        dataTransfer: { value: transfer },
      });
      fireEvent(bodies[0]!, event);
      return event;
    };
    expect(send("dragover").defaultPrevented).toBe(true);
    expect(useWorkspace.getState().tabs).toHaveLength(3);
    expect(send("drop").defaultPrevented).toBe(true);
    const state = useWorkspace.getState();
    expect(state.tabs).toHaveLength(4);
    expect(state.layout.kind).toBe("split");
    if (state.layout.kind !== "split") throw new Error("Expected root split");
    expect(state.layout.direction).toBe(test.direction);
    const leaf = test.position === "first" ? state.layout.first : state.layout.second;
    expect(leaf.kind).toBe("pane");
    if (leaf.kind !== "pane") throw new Error("Expected file pane");
    const owner = state.panes.find((pane) => pane.id === leaf.paneId)!;
    expect(state.tabs.find((tab) => tab.id === owner.activeId)?.filePane?.path).toBe("C:\\work");
    expect(test.position === "first" ? state.layout.ratio : 1 - state.layout.ratio).toBeCloseTo(
      test.fraction,
    );
    expect(onMoved).toHaveBeenCalledOnce();
    expect(workspace.querySelectorAll(".pane")).toHaveLength(3);
  });
});

describe("file tab remote monitor", () => {
  it.each(["monitor", "history"] as const)(
    "keeps the owning remote selected for a %s tab",
    (kind) => {
      const session = {
        id: "remote-qa",
        hostId: "host-qa",
        title: "Remote",
        address: "qa:22",
        cols: 80,
        rows: 24,
        connectedAt: 0,
      };
      useSsh.setState({ sessions: [session] });
      const id = `${kind}:${session.id}`;
      useWorkspace.setState({
        tabs: [{ id, kind, title: "Remote", hostId: session.hostId, pinned: false }],
        activeId: id,
        panes: [{ id: "pane-1", tabIds: [id], activeId: id }],
        activePaneId: "pane-1",
        layout: { kind: "pane", paneId: "pane-1" },
      });
      render(<AppShell />);
      expect(screen.getByTestId("remote-panel").textContent).toBe(session.id);
      act(() => useSsh.setState({ sessions: [] }));
      expect(screen.getByTestId("system-panel")).toBeTruthy();
    },
  );

  it("tracks the selected remote source, duplicate tabs and local panels", () => {
    useSsh.setState({
      sessions: ["a", "b"].map((id) => ({
        id,
        hostId: id,
        title: id,
        address: `${id}:22`,
        cols: 80,
        rows: 24,
        connectedAt: 0,
      })),
    });
    const id = "sftp:a:copy:duplicate";
    useWorkspace.setState({
      tabs: [{ id, kind: "sftp", title: "a", hostId: "a", pinned: false }],
      activeId: id,
      panes: [{ id: "pane-1", tabIds: [id], activeId: id }],
      activePaneId: "pane-1",
      layout: { kind: "pane", paneId: "pane-1" },
    });
    render(<AppShell />);
    expect(screen.getByTestId("remote-panel").textContent).toBe("a");
    act(() => useWorkspace.getState().setFileSession(id, "b"));
    expect(screen.getByTestId("remote-panel").textContent).toBe("b");
    act(() => useWorkspace.getState().setFileSession(id, null));
    expect(screen.getByTestId("system-panel")).toBeTruthy();
    act(() => useSsh.setState({ sessions: [] }));
  });
});

describe("workbench side widths", () => {
  it.each(["Sidebar width", "Panel width"])(
    "previews %s without rerendering the shell and persists only on release",
    (label) => {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, rightPanel: true } });
      const onRender = vi.fn();
      const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
      const view = render(
        <Profiler id="workbench" onRender={onRender}>
          <AppShell />
        </Profiler>,
      );
      const handle = screen.getByRole("separator", { name: label });
      const property = label === "Sidebar width" ? "--td-sidebar-w" : "--td-panel-w";
      const app = view.container.querySelector<HTMLElement>(".app")!;
      const before = app.style.getPropertyValue(property);
      const commits = onRender.mock.calls.length;
      const pointer = (type: string, x: number) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          clientX: x,
          buttons: type === "pointerup" ? 0 : 1,
        });
        Object.defineProperty(event, "pointerId", { value: 1 });
        fireEvent(type === "pointerdown" ? handle : window, event);
      };
      pointer("pointerdown", 500);
      pointer("pointermove", 530);
      act(() => frame.mock.calls[0]![0](0));
      expect(app.style.getPropertyValue(property)).not.toBe(before);
      expect(onRender).toHaveBeenCalledTimes(commits);
      expect(useSettings.getState().update).not.toHaveBeenCalled();
      pointer("pointerup", 540);
      expect(useSettings.getState().update).toHaveBeenCalledExactlyOnceWith(
        label === "Sidebar width"
          ? { sidebarWidth: DEFAULT_SETTINGS.sidebarWidth + 40 }
          : { rightPanelWidth: DEFAULT_SETTINGS.rightPanelWidth - 40 },
      );
    },
  );
});

describe("scoped plugin shortcut conflicts", () => {
  const plugin = (binding: string) =>
    ({
      id: "test",
      name: "Test",
      runtime: "node",
      views: [],
      commands: [{ id: "run", title: "Run", keybindings: [binding] }],
    }) as unknown as PluginInfo;

  it.each([
    { scope: "sftp-pane", binding: "Mod+F", key: "f" },
    { scope: "terminal-host", binding: "Mod+Shift+C", key: "C", shiftKey: true },
  ])(
    "runs a plugin once and retains the $scope handler",
    async ({ scope, binding, key, shiftKey }) => {
      usePlugins.setState({ items: [plugin(binding)] });
      const run = vi.spyOn(keyboardActions, "runWorkbenchCommand").mockReturnValue(true);
      const { container } = render(<AppShell />);
      const local = document.createElement("div");
      local.className = scope;
      local.tabIndex = 0;
      container.append(local);
      const handler = vi.fn((event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      local.addEventListener("keydown", handler);
      fireEvent.keyDown(local, { key, ctrlKey: true, shiftKey });
      await act(async () => {});
      expect(handler).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith("plugin.c.4.test.run");
      run.mockRestore();
    },
  );

  it("routes a plugin shortcut from the terminal even without a terminal command conflict", () => {
    usePlugins.setState({ items: [plugin("Mod+Shift+J")] });
    const run = vi.spyOn(keyboardActions, "runWorkbenchCommand").mockReturnValue(true);
    const { container } = render(<AppShell />);
    const host = document.createElement("div");
    host.className = "terminal-host";
    const input = document.createElement("textarea");
    host.append(input);
    container.append(host);
    const terminalHandler = vi.fn();
    input.addEventListener("keydown", terminalHandler);
    fireEvent.keyDown(input, { key: "J", ctrlKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledExactlyOnceWith("plugin.c.4.test.run");
    expect(terminalHandler).not.toHaveBeenCalled();
    run.mockRestore();
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
