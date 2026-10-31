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

import "@/i18n/i18n";
import { PluginsSection } from "@/features/plugins/PluginsSection";
import { usePlugins } from "@/store/plugins";

beforeEach(() => {
  usePlugins.setState({ items: [], busy: null, outputs: {} });
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
});
