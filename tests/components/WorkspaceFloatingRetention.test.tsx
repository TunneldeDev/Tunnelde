import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import "@/i18n/i18n";
const counters = vi.hoisted(() => ({ mounts: 0, disposals: 0 }));
vi.mock("@/features/terminal/TerminalPage", () => ({
  TerminalPage: function RetainedTerminal() {
    const [value, setValue] = useState("");
    useEffect(() => {
      counters.mounts++;
      return () => {
        counters.disposals++;
      };
    }, []);
    return (
      <input aria-label="Terminal draft" value={value} onChange={(e) => setValue(e.target.value)} />
    );
  },
}));
import { PaneLayout, FloatingWorkspaceLayer } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

beforeEach(() => {
  counters.mounts = counters.disposals = 0;
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useWorkspace.setState({
    tabs: [
      { id: "terminal:qa", kind: "terminal", title: "QA terminal", hostId: null, pinned: false },
    ],
    panes: [{ id: "main", tabIds: ["terminal:qa"], activeId: "terminal:qa" }],
    activePaneId: "main",
    activeId: "terminal:qa",
    layout: { kind: "pane", paneId: "main" },
    split: null,
  });
});
it("reparents the same page/input into the shared frame and back without remount or draft loss", () => {
  render(
    <>
      <PaneLayout />
      <div className="workbench-floating-layer">
        <FloatingWorkspaceLayer />
      </div>
      <WorkspaceContents />
    </>,
  );
  const input = screen.getByRole("textbox", { name: "Terminal draft" });
  fireEvent.change(input, { target: { value: "unsent command" } });
  act(() => useWorkspace.getState().floatTab("terminal:qa"));
  const dialog = screen.getByRole("dialog", { name: "QA terminal" });
  expect(dialog.contains(input)).toBe(true);
  expect(screen.getByRole("textbox", { name: "Terminal draft" })).toBe(input);
  expect(input).toHaveProperty("value", "unsent command");
  expect(counters).toEqual({ mounts: 1, disposals: 0 });
  // Dismiss is redocking, never an implicit close/disconnect of a live page.
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Terminal draft" })).toBe(input);
  expect(input).toHaveProperty("value", "unsent command");
  expect(counters).toEqual({ mounts: 1, disposals: 0 });
});
it("does not render a blank floating frame when its last remaining sidebar is collapsed", () => {
  useWorkspace.setState({
    tabs: [
      {
        id: "sidebar:output",
        kind: "sidebar",
        title: "Output",
        hostId: null,
        pinned: false,
        hidden: true,
      },
    ],
    panes: [
      { id: "main", tabIds: [], activeId: null },
      {
        id: "float",
        tabIds: ["sidebar:output"],
        activeId: null,
        floating: { bounds: null, returnPaneId: "main", order: 1 },
      },
    ],
    activePaneId: "main",
    activeId: null,
  });
  render(<FloatingWorkspaceLayer />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useWorkspace.getState().panes.find((p) => p.id === "float")?.tabIds).toEqual([
    "sidebar:output",
  ]);
});
