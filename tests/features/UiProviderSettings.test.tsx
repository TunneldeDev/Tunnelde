import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { UiProviderSettings } from "@/features/plugins/UiProviderSettings";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { plugin } from "../fixtures/plugins";

vi.mock("@/lib/extensions/frontendRuntime", () => ({
  frontendRuntime: { ensure: vi.fn(), view: vi.fn() },
}));
const start = vi.fn();
const update = vi.fn(async () => true);
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} }, update });
  usePlugins.setState({ items: [], start });
});

describe("compact interface provider settings", () => {
  it("starts collapsed and lets users expand without activating or saving anything", () => {
    const { container } = render(<UiProviderSettings />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("All built-in")).toBeTruthy();
    fireEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(true);
    expect(screen.getAllByRole("button")).toHaveLength(12);
    expect(start).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("shows selected and unavailable counts while collapsed and reveals settings when searched", () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        uiProviders: {
          preferences: { pluginId: plugin.id, viewId: "form" },
          terminal: { pluginId: "missing", viewId: "terminal" },
        },
      },
    });
    usePlugins.setState({
      items: [
        {
          ...plugin,
          frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
          permissions: ["ui.trusted", "settings.read"],
          views: [{ id: "form", title: "Form", kind: "component", provider: "preferences" }],
        },
      ],
    });
    const { container, rerender } = render(<UiProviderSettings />);
    expect(screen.getByText("2 customized · 1 unavailable")).toBeTruthy();
    expect(container.querySelector("details")!.open).toBe(false);
    rerender(<UiProviderSettings expanded />);
    expect(container.querySelector("details")!.open).toBe(true);
    expect(screen.getByRole("button", { name: "Terminal" }).textContent).toContain("Unavailable");
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.getByText("2 customized · 2 unavailable")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("can restore a missing provider without discarding other selections", async () => {
    const other = { pluginId: "other", viewId: "browser" };
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        uiProviders: {
          terminal: { pluginId: "missing", viewId: "terminal" },
          fileBrowser: other,
        },
      },
    });
    render(<UiProviderSettings expanded />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("option", { name: "Built-in" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ uiProviders: { fileBrowser: other } }),
    );
    expect(start).not.toHaveBeenCalled();
  });
});
