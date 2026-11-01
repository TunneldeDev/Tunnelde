// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, marketMock } = vi.hoisted(() => ({
  apiMock: {
    pluginsList: vi.fn(),
    pluginInstall: vi.fn(),
    marketplaceInstall: vi.fn(),
    pluginPickFolder: vi.fn(),
    pluginPickArchive: vi.fn(),
    pluginUninstall: vi.fn(),
    pluginReload: vi.fn(),
    pluginStart: vi.fn(),
    pluginStop: vi.fn(),
    pluginRun: vi.fn(),
    pluginOpenDir: vi.fn(),
    pluginRenderView: vi.fn(),
  },
  marketMock: {
    fetchMarketplace: vi.fn(),
    installMarketplaceEntry: vi.fn(),
  },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock, isTauri: () => false }));
vi.mock("@/lib/plugins/marketplace", () => marketMock);

import "@/i18n/i18n";
import { PluginsSection } from "@/features/plugins/PluginsSection";
import { PluginsSidebar } from "@/features/plugins/PluginsSidebar";
import { usePlugins } from "@/store/plugins";

const entry = {
  id: "hello",
  name: "Hello",
  version: "0.1.0",
  description: "Example plugin",
  url: "https://github.com/TunneldeDev/Tunnelde/releases/download/v0.14.1/hello-plugin.zip",
  sha256: "997c8382c9240692c6edaafbf4e2c34c4b1388d76a1b255ea97d6ba5bc6d5113",
};

const installedInfo = (item = entry) => ({
  ...item,
  apiVersion: 1,
  commands: [],
  views: [],
  permissions: [],
  status: "stopped" as const,
  error: null,
  path: `plugins/${item.id}`,
});

beforeEach(() => {
  usePlugins.setState({ items: [], busy: null, outputs: {} });
  apiMock.pluginsList.mockResolvedValue([]);
  marketMock.fetchMarketplace.mockReset().mockResolvedValue([entry]);
  marketMock.installMarketplaceEntry.mockReset().mockResolvedValue(installedInfo());
});

describe("Plugin marketplace", () => {
  it("keeps a successful installation visible when refreshing the installed list fails", async () => {
    const { container } = render(<PluginsSection />);
    const row = (await screen.findByText("Hello")).closest(".market-row") as HTMLElement;
    apiMock.pluginsList.mockRejectedValueOnce(new Error("list unavailable"));
    fireEvent.click(within(row).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(usePlugins.getState().items[0]?.id).toBe("hello"));
    const installed = container.querySelector(".plugin-list") as HTMLElement;
    expect(within(installed).getByText("Hello")).toBeTruthy();
    expect(
      (within(row).getByRole("button", { name: "Installed" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("filters marketplace search results and prevents reinstalling an installed plugin", async () => {
    const installed = {
      ...entry,
      apiVersion: 1,
      commands: [],
      views: [],
      permissions: [],
      status: "stopped",
      error: null,
      path: "plugins/hello",
    };
    apiMock.pluginsList.mockResolvedValue([installed]);
    render(<PluginsSidebar />);
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
    const row = (await screen.findByText("Hello")).closest(".market-row") as HTMLElement;
    expect(
      (within(row).getByRole("button", { name: "Installed" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "no-such-plugin" },
    });
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(marketMock.installMarketplaceEntry).not.toHaveBeenCalled();
  });

  it("retries an unavailable marketplace from the sidebar", async () => {
    marketMock.fetchMarketplace
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]);
    render(<PluginsSidebar />);
    fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
    expect(await screen.findByText("Marketplace unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No plugins published yet")).toBeTruthy();
    expect(marketMock.fetchMarketplace).toHaveBeenCalledTimes(2);
  });

  it("lists catalogue entries and installs one", async () => {
    render(<PluginsSection />);

    expect(await screen.findByText("Marketplace")).toBeTruthy();
    const row = (await screen.findByText("Hello")).closest(".market-row") as HTMLElement;
    expect(screen.getByText("0.1.0")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(marketMock.installMarketplaceEntry).toHaveBeenCalledWith(entry);
    });
  });

  it("says so when the catalogue cannot be loaded", async () => {
    marketMock.fetchMarketplace.mockRejectedValue(new Error("offline"));
    render(<PluginsSection />);
    expect(await screen.findByText("Marketplace unavailable")).toBeTruthy();
  });

  it("keeps each pending marketplace installation disabled independently", async () => {
    const second = { ...entry, id: "second", name: "Second" };
    marketMock.fetchMarketplace.mockResolvedValue([entry, second]);
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    marketMock.installMarketplaceEntry.mockImplementation(
      (item: { id: string }) =>
        new Promise<ReturnType<typeof installedInfo>>((resolve) => {
          if (item.id === entry.id) finishFirst = () => resolve(installedInfo(entry));
          else finishSecond = () => resolve(installedInfo(second));
        }),
    );
    render(<PluginsSection />);
    const firstRow = (await screen.findByText("Hello")).closest(".market-row") as HTMLElement;
    const secondRow = screen.getByText("Second").closest(".market-row") as HTMLElement;
    const firstButton = within(firstRow).getByRole("button", {
      name: "Install",
    }) as HTMLButtonElement;
    const secondButton = within(secondRow).getByRole("button", {
      name: "Install",
    }) as HTMLButtonElement;
    fireEvent.click(firstButton);
    fireEvent.click(secondButton);
    expect(firstButton.disabled).toBe(true);
    expect(secondButton.disabled).toBe(true);
    await act(async () => finishFirst());
    expect(firstButton.disabled).toBe(false);
    expect(secondButton.disabled).toBe(true);
    await act(async () => finishSecond());
    expect(secondButton.disabled).toBe(false);
  });
});
