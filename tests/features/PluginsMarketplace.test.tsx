import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  api: { pluginsList: vi.fn(), marketplaceDownload: vi.fn(), pluginOpenDir: vi.fn() },
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
import { useDialogs } from "@/store/dialogs";
import { useWorkspace } from "@/store/workspace";
import {
  catalogue,
  community,
  config,
  deferred,
  entry,
  official,
  plugin,
  themePack,
} from "../fixtures/plugins";

const getRow = (name = "Formatter") =>
  screen.getByText(name, { selector: "strong" }).closest("article")!;
const confirmInstall = async () => {
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw new Error("Missing install confirmation");
  await act(async () => {
    await dialog.onConfirm();
  });
};
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useMarketplace.setState({ ...useMarketplace.getInitialState(), config: config(), ready: true });
  usePlugins.setState({ ...usePlugins.getInitialState(), items: [] });
  useDialogs.setState({ dialog: { kind: "none" } });
  mock.api.pluginsList.mockResolvedValue([]);
  mock.api.marketplaceDownload.mockResolvedValue({ ...plugin, version: entry.version });
  mock.fetch.mockResolvedValue([entry]);
});
describe("conventional marketplace sidebar", () => {
  it("installs a pure theme pack with its theme contributions and no executable-code confirmation", async () => {
    const themeEntry = {
      ...entry,
      id: themePack.id,
      name: themePack.name,
      runtime: "theme" as const,
    };
    mock.fetch.mockResolvedValue([themeEntry]);
    mock.api.marketplaceDownload.mockResolvedValue(themePack);
    render(<PluginsSidebar />);
    await screen.findByText(themePack.name, { selector: "strong" });
    expect(screen.getByText("Theme pack")).toBeTruthy();
    fireEvent.click(within(getRow(themePack.name)).getByRole("button", { name: "Install" }));
    const confirmation = useDialogs.getState().dialog;
    if (confirmation.kind !== "confirm") throw new Error("Missing theme confirmation");
    expect(confirmation.body).not.toContain("contains executable code");
    await confirmInstall();
    await waitFor(() => expect(usePlugins.getState().items).toContainEqual(themePack));
    expect(usePlugins.getState().items[0]?.themes).toHaveLength(2);
  });
  it("opens a dedicated detail workspace tab and asks before installing executable code", async () => {
    const open = vi.fn();
    useWorkspace.setState({ openPluginDetail: open });
    render(<PluginsSidebar />);
    await screen.findByText("Formatter", { selector: "strong" });
    fireEvent.click(within(getRow()).getByRole("button", { name: /Formatter/ }));
    expect(open).toHaveBeenCalledWith("official", entry.id, entry.name);
    expect(screen.queryByText("Format JSON")).toBeNull();
    fireEvent.click(within(getRow()).getByRole("button", { name: "Install" }));
    const confirmation = useDialogs.getState().dialog;
    expect(confirmation.kind).toBe("confirm");
    if (confirmation.kind === "confirm") expect(confirmation.body).toContain(official.url);
    expect(mock.api.marketplaceDownload).not.toHaveBeenCalled();
    await confirmInstall();
    expect(mock.api.marketplaceDownload).toHaveBeenCalledWith(
      "official",
      entry.id,
      entry.version,
      entry.sha256,
      expect.stringContaining("plugin-formatter-"),
      false,
    );
    expect(usePlugins.getState().items).toContainEqual(
      expect.objectContaining({ id: entry.id, version: "2.0.0" }),
    );
  });

  it("searches metadata and filters updates using the original source identity", async () => {
    mock.api.pluginsList.mockResolvedValue([plugin]);
    render(<PluginsSidebar />);
    await screen.findByText("Formatter", { selector: "strong" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "tools publisher" },
    });
    expect(getRow()).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "nothing here" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /Updates/ }));
    fireEvent.click(within(getRow()).getByRole("button", { name: "Update" }));
    await confirmInstall();
    expect(mock.api.marketplaceDownload).toHaveBeenCalledWith(
      "official",
      entry.id,
      entry.version,
      entry.sha256,
      expect.any(String),
      true,
    );
  });

  it("keeps independent same-ID publishers visible without allowing silent source replacement", async () => {
    useMarketplace.setState({
      config: config([official, community]),
      catalogues: {
        official: catalogue(),
        community: catalogue(community, [{ ...entry, name: "Community Formatter" }]),
      },
    });
    mock.api.pluginsList.mockResolvedValue([plugin]);
    mock.fetch
      .mockImplementationOnce(async () => [entry])
      .mockImplementationOnce(async () => [{ ...entry, name: "Community Formatter" }]);
    render(<PluginsSidebar />);
    await screen.findByText("Community Formatter", { selector: "strong" });
    await waitFor(() =>
      expect(within(getRow()).queryByRole("button", { name: "Install" })).toBeNull(),
    );
    expect(
      within(getRow("Community Formatter")).queryByRole("button", { name: /Install|Update/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Updates/ }));
    expect(screen.getByText("Formatter", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText("Community Formatter", { selector: "strong" })).toBeNull();
  });

  it("retries unavailable sources and keeps stale cached entries usable", async () => {
    useMarketplace.setState({ catalogues: { official: { ...catalogue(), stale: true } } });
    mock.fetch.mockRejectedValueOnce(new Error("Network offline")).mockResolvedValueOnce([entry]);
    render(<PluginsSidebar />);
    expect(await screen.findByText("Marketplace unavailable")).toBeTruthy();
    expect(getRow()).toBeTruthy();
    expect(screen.getByText("Network offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Marketplace unavailable")).toBeNull());
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });

  it("tracks simultaneous installs independently and prevents a duplicate request", async () => {
    const second = { ...entry, id: "uuid", name: "UUID" };
    const a = deferred<typeof plugin>(),
      b = deferred<typeof plugin>();
    mock.fetch.mockResolvedValue([entry, second]);
    mock.api.marketplaceDownload.mockImplementation((_source, id) =>
      id === entry.id ? a.promise : b.promise,
    );
    render(<PluginsSidebar />);
    await screen.findByText("UUID", { selector: "strong" });
    let first!: Promise<void>, other!: Promise<void>;
    act(() => {
      first = useMarketplace.getState().install(entry, official, false);
      other = useMarketplace.getState().install(second, official, false);
    });
    expect(useMarketplace.getState().install(entry, official, false)).toBe(first);
    await waitFor(() => expect(mock.api.marketplaceDownload).toHaveBeenCalledTimes(2));
    expect(
      (within(getRow()).getByRole("button", { name: "Installing…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      a.resolve({ ...plugin, version: "2.0.0" });
      await first;
    });
    expect(useMarketplace.getState().tasks.formatter).toBeUndefined();
    expect(useMarketplace.getState().tasks.uuid).toBeTruthy();
    await act(async () => {
      b.resolve({ ...plugin, id: "uuid" });
      await other;
    });
    expect(useMarketplace.getState().tasks).toEqual({});
  });
});
