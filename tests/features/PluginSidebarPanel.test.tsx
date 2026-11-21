import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/plugins/PluginViewPage", () => ({
  PluginViewPage: ({ visible = true }: { visible?: boolean }) => (
    <div data-visible={visible}>Live plugin content</div>
  ),
}));

import "@/i18n/i18n";
import { PluginSidebarPanel } from "@/features/plugins/PluginSidebarPanel";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { WorkbenchPanel } from "@/components/layout/WorkbenchPanel";
import { plugin } from "../fixtures/plugins";

describe("plugin sidebar title ownership", () => {
  it("lets the workspace tab own a docked title and restores the sidebar header when returned", () => {
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
    const tab = {
      id: "sidebar:plugin:formatter:chat",
      kind: "sidebar" as const,
      title: "AI assistant",
      hostId: null,
      pinned: false,
    };
    useWorkspace.setState({ tabs: [tab] });
    const { container, rerender } = render(
      <WorkbenchPanel view="plugin:formatter:chat" location="workspace" visible>
        <PluginSidebarPanel view="plugin:formatter:chat" />
      </WorkbenchPanel>,
    );
    expect(container.querySelector(".sidebar__head")).toBeNull();
    const content = screen.getByText("Live plugin content");
    expect(content.dataset.visible).toBe("true");
    rerender(
      <WorkbenchPanel view="plugin:formatter:chat" location="workspace" visible={false}>
        <PluginSidebarPanel view="plugin:formatter:chat" visible={false} />
      </WorkbenchPanel>,
    );
    expect(content.dataset.visible).toBe("false");
    rerender(
      <WorkbenchPanel view="plugin:formatter:chat" location="sidebar" visible>
        <PluginSidebarPanel view="plugin:formatter:chat" visible />
      </WorkbenchPanel>,
    );
    expect(content.dataset.visible).toBe("true");
    act(() => useWorkspace.setState({ tabs: [] }));
    expect(container.querySelector(".workbench-panel__head")).toBeTruthy();
    expect(screen.getByText("AI assistant")).toBeTruthy();
    expect(screen.getByText("Live plugin content")).toBe(content);
  });
});
