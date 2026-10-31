// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("clears the previous view and ignores its late refresh after switching plugins", async () => {
    let finishRefresh!: (value: unknown) => void;
    let finishNewView!: (value: unknown) => void;
    apiMock.pluginRenderView
      .mockResolvedValueOnce({
        title: "First plugin",
        blocks: [{ type: "text", text: "Old content" }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNewView = resolve;
          }),
      );
    const { rerender } = render(<PluginViewPage pluginId="first" viewId="main" />);
    expect(await screen.findByText("Old content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<PluginViewPage pluginId="second" viewId="main" />);
    expect(screen.queryByText("Old content")).toBeNull();
    expect(screen.queryByText("First plugin")).toBeNull();
    await act(async () => finishRefresh({ title: "Stale response", blocks: [] }));
    expect(screen.queryByText("Stale response")).toBeNull();
    await act(async () => finishNewView({ title: "Second plugin", blocks: [] }));
    expect(screen.getByText("Second plugin")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("allows retry after a failed load and clears the error on success", async () => {
    apiMock.pluginRenderView.mockRejectedValueOnce(new Error("temporarily unavailable"));
    render(<PluginViewPage pluginId="hello" viewId="main" />);
    expect(await screen.findByText("temporarily unavailable")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    apiMock.pluginRenderView.mockResolvedValueOnce({ title: "Recovered", blocks: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Recovered")).toBeTruthy();
    expect(screen.queryByText("temporarily unavailable")).toBeNull();
  });
});
