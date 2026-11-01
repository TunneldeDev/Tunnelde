import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  api: {
    pluginsList: vi.fn(),
    pluginOpenDir: vi.fn(),
    pluginPickArchive: vi.fn(),
    pluginPickFolder: vi.fn(),
    pluginInspect: vi.fn(),
    pluginInstall: vi.fn(),
  },
  fetch: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: mock.api, isTauri: () => false }));
vi.mock("@/lib/plugins/marketplace", () => ({
  MARKETPLACE_INDEX_URL: "https://official.example/index.json",
  fetchMarketplace: mock.fetch,
}));
import i18n from "@/i18n/i18n";
import { PluginsSidebar } from "@/features/plugins/PluginsSidebar";
import { usePlugins } from "@/store/plugins";
import { useMarketplace } from "@/store/marketplace";
import { useWorkspace } from "@/store/workspace";
import { config, deferred, plugin, themePack } from "../fixtures/plugins";

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useMarketplace.setState({
    ...useMarketplace.getInitialState(),
    config: config(),
    ready: true,
    scope: "installed",
  });
  usePlugins.setState({ ...usePlugins.getInitialState() });
  mock.api.pluginsList.mockResolvedValue([plugin]);
  mock.fetch.mockResolvedValue([]);
  mock.api.pluginPickArchive.mockResolvedValue("C:/plugins/formatter.zip");
  mock.api.pluginPickFolder.mockResolvedValue(null);
  mock.api.pluginInspect.mockResolvedValue(plugin);
  mock.api.pluginInstall.mockResolvedValue(plugin);
});

describe("installed plugins sidebar", () => {
  it("distinguishes theme packs and previews their themes before local installation", async () => {
    mock.api.pluginsList.mockResolvedValue([themePack]);
    mock.api.pluginInspect.mockResolvedValue(themePack);
    render(<PluginsSidebar />);
    expect(await screen.findByText("Theme pack")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    expect(await within(dialog).findByText("Cobalt Dusk")).toBeTruthy();
    expect(within(dialog).getByText("Porcelain")).toBeTruthy();
    expect(within(dialog).queryByText(/contains executable code/)).toBeNull();
    expect(
      (within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("searches installed metadata and opens details without expanding controls in the sidebar", async () => {
    const open = vi.fn();
    useWorkspace.setState({ openPluginDetail: open });
    render(<PluginsSidebar />);
    const name = await screen.findByText("Formatter", { selector: "strong" });
    fireEvent.click(name.closest("button")!);
    expect(open).toHaveBeenCalledWith("local", plugin.id, plugin.name);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByText("JSON tool")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "nothing" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "local json" },
    });
    expect(screen.getByText("Formatter", { selector: "strong" })).toBeTruthy();
  });

  it("supports conventional tab and row keyboard navigation", async () => {
    mock.api.pluginsList.mockResolvedValue([plugin, { ...plugin, id: "second", name: "Second" }]);
    render(<PluginsSidebar />);
    const first = (await screen.findByText("Formatter", { selector: "strong" })).closest("button")!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByText("Second", { selector: "strong" }).closest("button"),
    );
    const installed = screen.getByRole("tab", { name: /Installed/ });
    fireEvent.keyDown(installed, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Marketplace" }));
    await waitFor(() => expect(screen.getByText("No plugins published yet")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("tab", { name: "Marketplace" }), { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Updates/ }));
  });

  it("inspects a picked archive before installing and refreshes the same path when picked again", async () => {
    render(<PluginsSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(
      (within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const browse = within(dialog).getByRole("button", { name: /archive/i });
    fireEvent.click(browse);
    expect(await within(dialog).findByText("Formatter", { selector: "strong" })).toBeTruthy();
    fireEvent.click(browse);
    await waitFor(() => expect(mock.api.pluginInspect).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText("Formatter", { selector: "strong" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(mock.api.pluginInstall).toHaveBeenCalledWith("C:/plugins/formatter.zip"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps installation disabled for invalid or incompatible packages", async () => {
    mock.api.pluginInspect
      .mockRejectedValueOnce(new Error("Invalid manifest"))
      .mockResolvedValueOnce({ ...plugin, apiVersion: 99 });
    render(<PluginsSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    expect(
      await within(dialog).findByText("This plugin requires an unsupported plugin API version."),
    ).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mock.api.pluginInstall).not.toHaveBeenCalled();
  });

  it("ignores an outdated inspection response after another package is chosen", async () => {
    const old = deferred<typeof plugin>();
    mock.api.pluginInspect
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...plugin, name: "Replacement" });
    mock.api.pluginPickFolder.mockResolvedValue("C:/plugins/replacement");
    render(<PluginsSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(mock.api.pluginInspect).toHaveBeenCalledOnce());
    fireEvent.click(within(dialog).getByRole("button", { name: /folder/i }));
    expect(await within(dialog).findByText("Replacement", { selector: "strong" })).toBeTruthy();
    await act(async () => old.resolve(plugin));
    expect(within(dialog).queryByText("Formatter", { selector: "strong" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mock.api.pluginInstall).not.toHaveBeenCalled();
  });
});
