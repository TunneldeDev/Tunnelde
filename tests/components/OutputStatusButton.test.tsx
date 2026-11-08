import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { OutputStatusButton } from "@/features/output/OutputStatusButton";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: true,
    visitedSidebars: ["hosts"],
  });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activeId: null,
    activePaneId: "pane-1",
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
});

it("opens output below an empty workspace, toggles it and preserves a moved, resized pane", () => {
  render(<OutputStatusButton />);
  const button = screen.getByRole("button", { name: "Output" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(useWorkspace.getState().layout).toMatchObject({
    kind: "split",
    direction: "column",
    ratio: 0.68,
  });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(useNavigation.getState().activeSidebar).toBe("hosts");
  act(() => {
    const workspace = useWorkspace.getState();
    workspace.splitTab("sidebar:output", "row", "after", "root");
    const layout = useWorkspace.getState().layout;
    if (layout.kind === "split") useWorkspace.getState().resizeSplit(layout.id, 0.73);
    useWorkspace.getState().activate("page:welcome");
  });
  const saved = useWorkspace.getState().layout;
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(useWorkspace.getState().layout).toEqual(saved);
  expect(useWorkspace.getState().tabs.filter((tab) => tab.id === "sidebar:output")).toHaveLength(1);
});

it("reopens a closed output below the workspace even if it was previously visited", () => {
  useNavigation.setState({ visitedSidebars: ["hosts", "output"] });
  render(<OutputStatusButton />);
  const button = screen.getByRole("button", { name: "Output" });
  fireEvent.click(button);
  expect(useWorkspace.getState().layout).toMatchObject({ kind: "split", direction: "column" });
  act(() => {
    useWorkspace.getState().close("sidebar:output");
    useNavigation.getState().showSidebar("hosts");
  });
  fireEvent.click(button);
  expect(useWorkspace.getState().layout).toMatchObject({ kind: "split", direction: "column" });
  expect(useNavigation.getState().activeSidebar).toBe("hosts");
});

it("can hide a deliberately returned sidebar and Show output remains idempotent", () => {
  useNavigation.setState({ activeSidebar: "output", visitedSidebars: ["hosts", "output"] });
  render(<OutputStatusButton />);
  const button = screen.getByRole("button", { name: "Output" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  const saved = useWorkspace.getState().layout;
  act(() => useNavigation.getState().showOutput());
  expect(useWorkspace.getState().layout).toEqual(saved);
  expect(button.getAttribute("aria-expanded")).toBe("true");
});
