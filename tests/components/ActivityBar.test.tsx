import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import "@/i18n/i18n";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

beforeEach(() => {
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: true,
    visitedSidebars: ["hosts"],
    settingsSection: "general",
  });
  useWorkspace.setState({
    tabs: [],
    activeId: null,
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
});

describe("activity sidebar navigation", () => {
  it("selects one side view without opening a workspace page or changing settings", () => {
    render(<ActivityBar />);
    expect(screen.queryByRole("button", { name: "Welcome" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Trusted hosts" }));
    expect(useNavigation.getState().activeSidebar).toBe("knownHosts");
    expect(screen.getByRole("button", { name: "Trusted hosts" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Hosts" }).getAttribute("aria-pressed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(useNavigation.getState().activeSidebar).toBe("plugins");
    expect(useNavigation.getState().settingsSection).toBe("general");
    expect(useWorkspace.getState().tabs).toEqual([]);
    expect(useNavigation.getState().visitedSidebars).toEqual(["hosts", "knownHosts", "plugins"]);
  });

  it("clears the highlight when collapsed and restores it when reopened", () => {
    render(<ActivityBar />);
    const hosts = screen.getByRole("button", { name: "Hosts" });
    fireEvent.click(hosts);
    expect(useNavigation.getState().sidebarVisible).toBe(false);
    expect(hosts.getAttribute("aria-pressed")).toBeNull();
    expect(hosts.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(hosts);
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(hosts.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hosts);
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(useNavigation.getState().activeSidebar).toBe("plugins");
  });

  it("retains activity selection while switching editor tabs and opening global settings", () => {
    render(<ActivityBar />);
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    act(() => useWorkspace.getState().openPage("welcome"));
    const welcome = useWorkspace.getState().activeId!;
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      useWorkspace.getState().tabs.find((tab) => tab.id === useWorkspace.getState().activeId)?.kind,
    ).toBe("settings");
    expect(screen.getByRole("button", { name: "Plugins" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    act(() => useWorkspace.getState().activate(welcome));
    expect(screen.getByRole("button", { name: "Plugins" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(useNavigation.getState().sidebarVisible).toBe(true);
  });

  it("keeps a visible docked panel highlighted while another group has focus", () => {
    useWorkspace.getState().openPage("welcome");
    const welcome = useWorkspace.getState().activeId!;
    const mainPane = useWorkspace.getState().activePaneId;
    useWorkspace.getState().splitTab("sidebar:hosts", "row", "after", mainPane);
    render(<ActivityBar />);
    const hosts = screen.getByRole("button", { name: "Hosts" });
    expect(hosts.getAttribute("aria-pressed")).toBe("true");
    act(() => useWorkspace.getState().activate(welcome));
    expect(hosts.getAttribute("aria-pressed")).toBe("true");
    expect(hosts.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hosts);
    expect(hosts.getAttribute("aria-pressed")).toBeNull();
    expect(hosts.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(hosts);
    expect(hosts.getAttribute("aria-pressed")).toBe("true");
    expect(hosts.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a requested sidebar idempotently and exposes plugin configuration in Settings", () => {
    useNavigation.getState().showSidebar("knownHosts");
    useNavigation.getState().showSidebar("knownHosts");
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(useNavigation.getState().visitedSidebars).toEqual(["hosts", "knownHosts"]);
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav.textContent).not.toContain("Trusted hosts");
    expect(nav.textContent).toContain("Plugins");
    expect(useNavigation.getState().activeSidebar).toBe("knownHosts");
  });
});
