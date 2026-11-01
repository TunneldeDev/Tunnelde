// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useHosts } from "@/store/hosts";
import { useNavigation } from "@/store/navigation";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

beforeEach(() => {
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
  });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useHosts.setState({ hosts: [] });
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: false,
    visitedSidebars: ["hosts"],
  });
});

describe("CommandPalette", () => {
  it("filters commands while typing", () => {
    render(<CommandPalette open onClose={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText("Type a command"), {
      target: { value: "welcome" },
    });
    expect(screen.getByRole("option", { name: "Welcome" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Settings" })).toBeNull();
  });

  it("runs the highlighted command with Enter", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    const input = screen.getByPlaceholderText("Type a command");
    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onClose).toHaveBeenCalled();
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toContain("settings");
  });

  it("reports when nothing matches", () => {
    render(<CommandPalette open onClose={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText("Type a command"), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("No command matches")).toBeTruthy();
  });

  it("opens the trusted-host sidebar without creating a tab", () => {
    render(<CommandPalette open onClose={() => undefined} />);
    const input = screen.getByPlaceholderText("Type a command");
    fireEvent.change(input, { target: { value: "Trusted hosts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useNavigation.getState().activeSidebar).toBe("knownHosts");
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(useWorkspace.getState().tabs).toEqual([]);
  });
});
