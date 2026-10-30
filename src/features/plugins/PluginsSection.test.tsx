// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginInfo } from "@/lib/types";

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
    },
  };
});

vi.mock("@/lib/ipc", () => ({ api: apiMock }));

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
    start.click();
    await waitFor(() => {
      expect(usePlugins.getState().items[0]?.status).toBe("running");
    });
  });
});
