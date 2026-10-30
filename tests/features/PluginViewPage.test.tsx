// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    pluginRenderView: vi.fn(),
  },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));

import "@/i18n/i18n";
import { PluginViewPage } from "@/features/plugins/PluginViewPage";

describe("PluginViewPage", () => {
  it("renders heading, key/value and table blocks", async () => {
    apiMock.pluginRenderView.mockResolvedValue({
      title: "Hello plugin",
      blocks: [
        { type: "heading", text: "Example view" },
        { type: "text", text: "Rendered by the host" },
        { type: "kv", items: [{ label: "Plugin", value: "hello" }] },
        { type: "table", columns: ["Metric", "Value"], rows: [["cpu", "0.1"]] },
      ],
    });

    render(<PluginViewPage pluginId="hello" viewId="hello" />);

    expect(await screen.findByText("Example view")).toBeTruthy();
    expect(screen.getByText("Hello plugin")).toBeTruthy();
    expect(screen.getByText("Rendered by the host")).toBeTruthy();
    expect(screen.getByText("Plugin")).toBeTruthy();
    expect(screen.getAllByText("hello").length).toBeGreaterThan(0);
    expect(screen.getByText("cpu")).toBeTruthy();
    expect(screen.getByText("0.1")).toBeTruthy();
  });

  it("shows the empty state for an empty payload", async () => {
    apiMock.pluginRenderView.mockResolvedValue({ blocks: [] });
    render(<PluginViewPage pluginId="hello" viewId="empty" />);
    expect(await screen.findByText("No content")).toBeTruthy();
  });
});
