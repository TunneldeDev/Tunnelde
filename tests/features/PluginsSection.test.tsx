// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginInfo } from "@/lib/api/types";

const { plugin, apiMock } = vi.hoisted(() => {
  const plugin = {
    id: "hello",
    name: "Hello",
    version: "0.1.0",
    apiVersion: 1,
    description: "Minimal example plugin",
    commands: [{ id: "greet", title: "Say hello" }],
    views: [{ id: "hello", title: "Hello panel" }],
    permissions: ["log"],
    status: "stopped",
    error: null,
    path: "plugins/hello",
  };
  return {
    plugin,
    apiMock: {
      pluginsList: vi.fn(),
      pluginStart: vi.fn(),
      pluginStop: vi.fn(),
      pluginRun: vi.fn(),
      pluginOpenDir: vi.fn(),
      pluginPickArchive: vi.fn(),
      pluginPickFolder: vi.fn(),
      pluginInspect: vi.fn(),
      pluginInstall: vi.fn(),
    },
  };
});

vi.mock("@/lib/api/ipc", () => ({ api: apiMock, isTauri: () => false }));
vi.mock("@/lib/plugins/marketplace", () => ({
  fetchMarketplace: vi.fn().mockResolvedValue([]),
  installMarketplaceEntry: vi.fn(),
}));

import "@/i18n/i18n";
import { PluginsSection } from "@/features/plugins/PluginsSection";
import { PluginsSidebar } from "@/features/plugins/PluginsSidebar";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { fetchMarketplace } from "@/lib/plugins/marketplace";

beforeEach(() => {
  vi.mocked(fetchMarketplace).mockResolvedValue([]);
  usePlugins.setState({ items: [], busy: null, busyIds: [], reloading: false, outputs: {} });
  apiMock.pluginsList.mockResolvedValue([plugin as PluginInfo]);
  apiMock.pluginStart.mockResolvedValue({ ...plugin, status: "running" } as PluginInfo);
  apiMock.pluginStop.mockResolvedValue(plugin as PluginInfo);
  apiMock.pluginRun.mockResolvedValue({ message: "Hello from the example plugin" });
  apiMock.pluginOpenDir.mockResolvedValue(undefined);
  apiMock.pluginPickArchive.mockResolvedValue("C:/plugins/hello.zip");
  apiMock.pluginPickFolder.mockResolvedValue(null);
  apiMock.pluginInspect.mockResolvedValue(plugin);
  apiMock.pluginInstall.mockResolvedValue(plugin);
});

describe("PluginsSidebar", () => {
  it("searches installed plugins in its own sidebar and keeps details collapsed", async () => {
    const { container } = render(<PluginsSidebar />);
    expect(await screen.findByText("Hello")).toBeTruthy();
    expect(container.querySelector(".plugins-sidebar")).toBeTruthy();
    expect(container.querySelector(".settings-section")).toBeNull();
    expect(screen.queryByText("Say hello")).toBeNull();
    const search = screen.getByRole("textbox", { name: "Search plugins" });
    fireEvent.change(search, { target: { value: "not-installed" } });
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.change(search, { target: { value: "minimal" } });
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("starts the selected plugin and opens its view in the workspace", async () => {
    const openView = vi.fn();
    useWorkspace.setState({ openPluginView: openView });
    render(<PluginsSidebar />);
    fireEvent.click((await screen.findByText("Hello")).closest("button")!);
    const view = screen.getByRole("button", { name: "Hello panel" }) as HTMLButtonElement;
    expect(view.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(view.disabled).toBe(false));
    fireEvent.click(view);
    expect(openView).toHaveBeenCalledWith("hello", "hello", "Hello panel");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("offers installation through the package preview dialog", async () => {
    render(<PluginsSidebar />);
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    expect(await within(dialog).findByText("Hello")).toBeTruthy();
    expect(apiMock.pluginInspect).toHaveBeenCalledWith("C:/plugins/hello.zip");
  });

  it("switches to the empty marketplace with standard tab keyboard navigation", async () => {
    render(<PluginsSidebar />);
    await screen.findByText("Hello");
    const installed = screen.getByRole("tab", { name: /Installed/ });
    installed.focus();
    fireEvent.keyDown(installed, { key: "ArrowRight" });
    const market = screen.getByRole("tab", { name: "Marketplace" });
    expect(document.activeElement).toBe(market);
    expect(market.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("No plugins published yet")).toBeTruthy();
    expect(screen.queryByText("Hello")).toBeNull();
    fireEvent.keyDown(market, { key: "Home" });
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(installed.getAttribute("aria-selected")).toBe("true");
  });
});

describe("PluginsSection", () => {
  it("lists discovered plugins", async () => {
    render(<PluginsSection />);
    expect(await screen.findByText("Hello")).toBeTruthy();
    expect(screen.getByText("Say hello")).toBeTruthy();
    expect(screen.getByText("log")).toBeTruthy();
  });

  it("starts a stopped plugin", async () => {
    render(<PluginsSection />);
    const start = await screen.findByRole("button", { name: "Start" });
    fireEvent.click(start);
    await waitFor(() => {
      expect(usePlugins.getState().items[0]?.status).toBe("running");
    });
  });

  it("previews a picked package before installing it", async () => {
    render(<PluginsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(
      (within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(apiMock.pluginInspect).toHaveBeenCalledWith("C:/plugins/hello.zip"));
    expect(await within(dialog).findByText("Hello")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(apiMock.pluginInstall).toHaveBeenCalledWith("C:/plugins/hello.zip"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps installation disabled for an invalid package", async () => {
    apiMock.pluginInspect.mockRejectedValueOnce(new Error("invalid manifest"));
    render(<PluginsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("rechecks a package when the same archive is selected again", async () => {
    render(<PluginsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const dialog = screen.getByRole("dialog");
    const browse = within(dialog).getByRole("button", { name: /archive/i });
    fireEvent.click(browse);
    expect(await within(dialog).findByText("Hello")).toBeTruthy();
    fireEvent.click(browse);
    await waitFor(() => expect(apiMock.pluginInspect).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText("Hello")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
