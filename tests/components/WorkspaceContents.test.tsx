import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PaneLayout } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { useWorkspace } from "@/store/workspace";

const { mounted, unmounted } = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock("@/features/terminal/TerminalPage", () => ({
  TerminalPage: ({ sessionId }: { sessionId: string }) => {
    useEffect(() => {
      mounted(sessionId);
      return () => {
        unmounted(sessionId);
      };
    }, [sessionId]);
    return <textarea aria-label={`terminal ${sessionId}`} defaultValue="scrollback" />;
  },
}));
vi.mock("@/features/plugins/PluginViewPage", () => ({
  PluginViewPage: ({ visible }: { visible: boolean }) => (
    <div data-testid="plugin-visibility" data-visible={visible} />
  ),
}));

beforeEach(() => {
  mounted.mockClear();
  unmounted.mockClear();
  useWorkspace.setState({
    tabs: [
      { id: "terminal:a", kind: "terminal", title: "A", hostId: "a", pinned: false },
      { id: "terminal:b", kind: "terminal", title: "B", hostId: "b", pinned: false },
      { id: "terminal:c", kind: "terminal", title: "C", hostId: "c", pinned: false },
    ],
    panes: [
      { id: "pane-1", tabIds: ["terminal:a", "terminal:b", "terminal:c"], activeId: "terminal:a" },
    ],
    activePaneId: "pane-1",
    activeId: "terminal:a",
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
});

describe("workspace page ownership", () => {
  it("keeps a plugin visible in an unfocused group and suspends it only when its own tab is hidden", () => {
    const id = "plugin:formatter:main";
    useWorkspace.setState((state) => ({
      tabs: [
        ...state.tabs,
        { id, kind: "pluginView", title: "Plugin", hostId: null, pinned: false },
      ],
      panes: [{ ...state.panes[0]!, tabIds: [...state.panes[0]!.tabIds, id] }],
    }));
    render(
      <>
        <PaneLayout />
        <WorkspaceContents />
      </>,
    );
    const view = screen.getByTestId("plugin-visibility");
    expect(view.dataset.visible).toBe("false");
    act(() => useWorkspace.getState().splitTab(id, "row"));
    expect(view.dataset.visible).toBe("true");
    act(() => useWorkspace.getState().activate("terminal:a"));
    expect(view.dataset.visible).toBe("true");
    const group = useWorkspace.getState().panes.find((pane) => pane.tabIds.includes(id))!;
    act(() => useWorkspace.getState().moveTab("terminal:b", group.id));
    expect(view.dataset.visible).toBe("false");
    act(() => useWorkspace.getState().activate(id));
    expect(view.dataset.visible).toBe("true");
    expect(screen.getByTestId("plugin-visibility")).toBe(view);
  });

  it("keeps a preview before a user edits its form so navigating cannot lose the draft", () => {
    useWorkspace.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === "terminal:a" ? { ...tab, preview: true } : tab)),
    }));
    render(
      <>
        <PaneLayout />
        <WorkspaceContents />
      </>,
    );
    fireEvent.input(screen.getByLabelText("terminal a"), { target: { value: "unsent draft" } });
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === "terminal:a")?.preview).toBe(
      false,
    );
    act(() => useWorkspace.getState().openPage("settings"));
    expect((screen.getByLabelText("terminal a") as HTMLTextAreaElement).value).toBe("unsent draft");
  });

  it("keeps page instances and DOM state when splitting, moving and merging groups", () => {
    render(
      <>
        <PaneLayout />
        <WorkspaceContents />
      </>,
    );
    const terminal = screen.getByLabelText("terminal a");
    fireEvent.change(terminal, { target: { value: "retained scrollback" } });
    act(() => useWorkspace.getState().splitTab("terminal:a", "row"));
    act(() => useWorkspace.getState().splitTab("terminal:b", "column", "before", "pane-1"));
    const destination = useWorkspace
      .getState()
      .panes.find((pane) => pane.tabIds.includes("terminal:c"))!;
    act(() => useWorkspace.getState().moveTab("terminal:a", destination.id));
    act(() => useWorkspace.getState().closePane(destination.id));
    expect(screen.getByLabelText("terminal a")).toBe(terminal);
    expect((terminal as HTMLTextAreaElement).value).toBe("retained scrollback");
    expect(mounted).toHaveBeenCalledTimes(3);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("focuses the pane containing portal content on pointer interaction", () => {
    render(
      <>
        <PaneLayout />
        <WorkspaceContents />
      </>,
    );
    act(() => useWorkspace.getState().splitTab("terminal:a", "row"));
    const other = useWorkspace.getState().panes.find((pane) => pane.tabIds.includes("terminal:b"))!;
    fireEvent.mouseDown(screen.getByLabelText("terminal b"));
    expect(useWorkspace.getState().activePaneId).toBe(other.id);
  });

  it("routes a tab dropped on portal content to its actual destination group", () => {
    render(
      <>
        <PaneLayout />
        <WorkspaceContents />
      </>,
    );
    act(() => useWorkspace.getState().splitTab("terminal:a", "row"));
    const destination = useWorkspace
      .getState()
      .panes.find((pane) => pane.tabIds.includes("terminal:b"))!;
    const target = screen.getByLabelText("terminal b");
    vi.spyOn(target.closest(".pane__body")!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 600,
      right: 400,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const event = createEvent.drop(target, {
      dataTransfer: { types: ["application/x-tunnelde-tab"], getData: () => "terminal:a" },
    });
    Object.defineProperties(event, { clientX: { value: 200 }, clientY: { value: 300 } });
    fireEvent(target, event);
    expect(
      useWorkspace.getState().panes.find((pane) => pane.id === destination.id)?.tabIds,
    ).toContain("terminal:a");
    expect(mounted).toHaveBeenCalledTimes(3);
    expect(unmounted).not.toHaveBeenCalled();
  });
});
