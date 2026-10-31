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
import { usePlugins } from "@/store/plugins";

const entry = {
  id: "hello",
  name: "Hello",
  version: "0.1.0",
  description: "Example plugin",
  url: "https://github.com/TunneldeDev/Tunnelde/releases/download/v0.14.1/hello-plugin.zip",
  sha256: "997c8382c9240692c6edaafbf4e2c34c4b1388d76a1b255ea97d6ba5bc6d5113",
};

beforeEach(() => {
  usePlugins.setState({ items: [], busy: null, outputs: {} });
  apiMock.pluginsList.mockResolvedValue([]);
  marketMock.fetchMarketplace.mockReset().mockResolvedValue([entry]);
  marketMock.installMarketplaceEntry.mockReset().mockResolvedValue({ id: "hello" });
});

describe("Plugin marketplace", () => {
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
        new Promise<void>((resolve) => {
          if (item.id === entry.id) finishFirst = resolve;
          else finishSecond = resolve;
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
