// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "@/lib/api/ipc";

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@/lib/api/ipc", async (original) => ({
  ...(await original<typeof IpcModule>()),
  isTauri: mocks.native,
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/components/layout/TabContent", () => ({ TabContent: () => null }));

import "@/i18n/i18n";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { SettingsPage } from "@/features/settings/SettingsPage";
import type { AppInfo } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useNavigation } from "@/store/navigation";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.native.mockReturnValue(true);
  mocks.minimize.mockResolvedValue(undefined);
  mocks.toggleMaximize.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.startDragging.mockResolvedValue(undefined);
  mocks.isMaximized.mockResolvedValue(false);
  mocks.onResized.mockResolvedValue(vi.fn());
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, titleBarStyle: "compact" },
    info: { os: "windows" } as AppInfo,
  });
  useNavigation.setState({ sidebarVisible: true, settingsSection: "general" });
});

describe("compact window controls", () => {
  it("renders no extra title or application menu and dispatches native window actions", async () => {
    render(<WindowTitleBar />);
    expect(screen.getByRole("toolbar").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1));
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.startDragging).not.toHaveBeenCalled();
  });

  it("allows dragging and double click on empty tab space while buttons keep their own actions", async () => {
    render(
      <>
        <WindowTitleBar />
        <div className="pane__tabs" data-testid="strip">
          <button>Tab</button>
        </div>
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("strip"), { button: 0, detail: 1 });
    fireEvent.doubleClick(screen.getByTestId("strip"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Tab" }), { button: 0, detail: 1 });
    fireEvent.doubleClick(screen.getByRole("button", { name: "Tab" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Close" }), { button: 0, detail: 1 });
    await waitFor(() => expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1));
    expect(mocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("reflects native maximize state after resize events", async () => {
    render(<WindowTitleBar />);
    await waitFor(() => expect(mocks.onResized).toHaveBeenCalledTimes(1));
    mocks.isMaximized.mockResolvedValue(true);
    await act(async () => {
      mocks.onResized.mock.calls[0]![0]();
    });
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("keeps native macOS traffic lights and supports dragging the existing tab row", () => {
    useSettings.setState({ info: { os: "macos" } as AppInfo });
    render(
      <>
        <WindowTitleBar />
        <div className="pane__tabs" data-testid="strip" />
      </>,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(mocks.onResized).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("strip"), { button: 0, detail: 1 });
    expect(mocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("cleans up a late resize subscription when returning to the system title bar", async () => {
    let resolve!: (stop: () => void) => void;
    mocks.onResized.mockReturnValueOnce(
      new Promise<() => void>((done) => {
        resolve = done;
      }),
    );
    render(<WindowTitleBar />);
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS }));
    const stop = vi.fn();
    await act(async () => resolve(stop));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("offers only system and compact title bar choices in Settings", () => {
    const update = vi.fn().mockResolvedValue(true);
    useSettings.setState({ update });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Window title bar" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System title bar",
      "Compact title bar",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "System title bar" }));
    expect(update).toHaveBeenCalledWith({ titleBarStyle: "system" });
    expect(screen.queryByText("Menu bar mode")).toBeNull();
  });
});

describe("window control space in nested groups", () => {
  it("reserves space in the top right group only, and moves the reservation to macOS's top left", () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, titleBarStyle: "compact", rightPanel: false },
    });
    useWorkspace.setState({
      tabs: ["a", "b", "c"].map((id) => ({
        id,
        kind: "about",
        title: id,
        hostId: null,
        pinned: false,
      })),
      panes: ["a", "b", "c"].map((id) => ({ id, tabIds: [id], activeId: id })),
      activePaneId: "a",
      activeId: "a",
      layout: {
        kind: "split",
        id: "outer",
        direction: "column",
        ratio: 0.5,
        first: {
          kind: "split",
          id: "top",
          direction: "row",
          ratio: 0.5,
          first: { kind: "pane", paneId: "a" },
          second: { kind: "pane", paneId: "b" },
        },
        second: { kind: "pane", paneId: "c" },
      },
    });
    const { container } = render(<PaneLayout />);
    expect(container.querySelectorAll(".has-window-controls")).toHaveLength(1);
    expect(container.querySelector('.has-window-controls [data-tab-id="b"]')).toBeTruthy();
    act(() => {
      useSettings.setState({ info: { os: "macos" } as AppInfo });
      useNavigation.setState({ sidebarVisible: false });
    });
    expect(container.querySelectorAll(".has-window-controls")).toHaveLength(0);
    expect(container.querySelector('.has-native-window-controls [data-tab-id="a"]')).toBeTruthy();
  });
});
