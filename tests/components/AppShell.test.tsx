// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real pane layout, tab handlers and workspace store. Surrounding
// panels do not participate in workspace drag routing.
vi.mock("@/components/layout/HostTree", () => ({ HostTree: () => null }));
vi.mock("@/components/layout/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/layout/ActivityBar", () => ({ ActivityBar: () => null }));
vi.mock("@/components/layout/RemotePanel", () => ({ RemotePanel: () => null }));
vi.mock("@/components/layout/StatusBar", () => ({ StatusBar: () => null }));
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
  const strips = [...workspace.querySelectorAll(".pane__tabs")];
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
