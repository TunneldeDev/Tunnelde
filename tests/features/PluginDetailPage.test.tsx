import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { PluginDetailPage, requestMarketInstall } from "@/features/plugins/PluginDetailPage";
import { usePlugins } from "@/store/plugins";
import { useMarketplace } from "@/store/marketplace";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import formatterReadme from "../fixtures/plugin-readme.md?raw";
import {
  catalogue,
  community,
  config,
  deferred,
  entry,
  official,
  plugin,
  darkTheme,
  lightTheme,
  themePack,
} from "../fixtures/plugins";
const copy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session/clipboard", () => ({ copyText: copy }));
const load = vi.fn(async () => {}),
  install = vi.fn(async () => {}),
  start = vi.fn(async () => {
    usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
  });
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useMarketplace.setState({
    ...useMarketplace.getInitialState(),
    config: config(),
    ready: true,
    catalogues: { official: catalogue() },
    load,
    install,
  });
  usePlugins.setState({ ...usePlugins.getInitialState(), items: [plugin], load, start });
  useWorkspace.setState({ openPluginView: vi.fn() });
  useDialogs.setState({ dialog: { kind: "none" } });
  useSettings.setState({
    settings: DEFAULT_SETTINGS,
    update: useSettings.getInitialState().update,
  });
});
describe("plugin workspace details", () => {
  it.each([1, 2, 99])("checks manifest admission %i for marketplace installation", (apiVersion) => {
    usePlugins.setState({ items: [] });
    useMarketplace.setState({
      catalogues: { official: catalogue(official, [{ ...entry, apiVersion }]) },
    });
    render(<PluginDetailPage sourceId="official" pluginId={entry.id} />);
    const install = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(install.disabled).toBe(apiVersion === 99);
    expect(screen.queryByText(i18n.t("market.incompatibleApi")) !== null).toBe(apiVersion === 99);
  });

  it("shows required dependency IDs and version ranges from installed metadata", () => {
    usePlugins.setState({
      items: [
        { ...plugin, apiVersion: 2, dependencies: [{ id: "shared-tools", version: "^1.0" }] },
      ],
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByText("shared-tools · ^1.0")).toBeTruthy();
  });
  it("keeps Stop available during a command and disables it only while stopping", () => {
    const stop = vi.fn(async () => {});
    usePlugins.setState({
      items: [{ ...plugin, status: "running" }],
      commandingIds: [plugin.id],
      busyIds: [plugin.id],
      stop,
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    const button = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(stop).toHaveBeenCalledWith(plugin.id);
    act(() => usePlugins.setState({ commandingIds: [], stoppingIds: [plugin.id] }));
    expect(button.disabled).toBe(true);
  });
  it("keeps cancellation available while activation is pending", () => {
    const stop = vi.fn(async () => {});
    usePlugins.setState({ startingIds: [plugin.id], busyIds: [plugin.id], stop });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    const button = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByText("Starting…")).toBeTruthy();
    fireEvent.click(button);
    expect(stop).toHaveBeenCalledWith(plugin.id);
    expect(start).not.toHaveBeenCalled();
  });
  it("does not render an empty Open tool section for provider-only packages", () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          views: [{ id: "desktop", title: "Desktop", kind: "component", provider: "workbench" }],
        },
      ],
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.queryByRole("heading", { name: "Open tool" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desktop" })).toBeNull();
  });
  it("shows declared application and API requirements without relying on README text", () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          runtime: "declarative",
          apiVersion: 1,
          engines: { tunnelde: ">=0.29.0-beta.6" },
          readme: null,
        },
      ],
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByText(">=0.29.0-beta.6")).toBeTruthy();
    expect(screen.getByText("Declarative (no Node.js required)")).toBeTruthy();
    expect(screen.getByText("Plugin API version")).toBeTruthy();
  });
  it("renders installed README contents as Markdown rather than displaying the source markers", () => {
    usePlugins.setState({ items: [{ ...plugin, readme: formatterReadme }] });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByRole("heading", { level: 1, name: "JSON Formatter" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Commands" })).toBeTruthy();
    expect(screen.queryByText("## Commands")).toBeNull();
  });
  it.each([1, 2])(
    "applies any of %i supplied themes immediately without a runtime startup",
    async (count) => {
      usePlugins.setState({ items: [{ ...themePack, themes: themePack.themes!.slice(0, count) }] });
      render(<PluginDetailPage sourceId="local" pluginId={themePack.id} />);
      expect(screen.queryByRole("button", { name: /^(Start|Stop)$/ })).toBeNull();
      expect(screen.queryByText("Stopped")).toBeNull();
      expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Apply theme" })).toHaveLength(count);
      const apply = useSettings.getState().update;
      const update = vi.fn(apply);
      useSettings.setState({ update });
      fireEvent.click(
        within(screen.getByRole("article", { name: darkTheme.name })).getByRole("button", {
          name: "Apply theme",
        }),
      );
      expect(update).toHaveBeenCalledWith({
        theme: "dark",
        accent: darkTheme.accent,
        colors: darkTheme.colors,
      });
      expect(useSettings.getState().settings.colors).toEqual(darkTheme.colors);
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(
        within(screen.getByRole("article", { name: darkTheme.name }))
          .getByRole("button", { name: "Applied" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      if (count === 2) {
        fireEvent.click(
          within(screen.getByRole("article", { name: lightTheme.name })).getByRole("button", {
            name: "Apply theme",
          }),
        );
        expect(update).toHaveBeenLastCalledWith({
          theme: "light",
          accent: "blue",
          colors: lightTheme.colors,
        });
        expect(useSettings.getState().settings.colors).toEqual(lightTheme.colors);
        expect(document.documentElement.dataset.theme).toBe("light");
      }
      expect(start).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
      });
    },
  );

  it("allows themes from an executable plugin without starting it", () => {
    usePlugins.setState({ items: [{ ...plugin, themes: [darkTheme] }] });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply theme" })).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "describes theme-only installation/update without an executable warning (update=%s)",
    (update) => {
      requestMarketInstall(
        { ...entry, id: themePack.id, name: themePack.name, runtime: "theme" },
        official,
        update,
      );
      const confirmation = useDialogs.getState().dialog;
      if (confirmation.kind !== "confirm") throw new Error("Missing theme confirmation");
      expect(confirmation.body).not.toContain("contains executable code");
      expect(confirmation.body).not.toContain("remain stopped");
      expect(confirmation.body).toContain(themePack.name);
      expect(confirmation.body).toContain(official.url);
    },
  );
  it("keeps installed plugin controls available after its source is removed", () => {
    useMarketplace.setState({ config: config([]), catalogues: {} });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByRole("heading", { name: "Formatter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy();
    expect(screen.getByText("Unknown publisher")).toBeTruthy();
    expect(screen.getByText(official.url)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
  });

  it("does not offer updates from an edited URL but keeps the installed tool usable", () => {
    const edited = { ...official, url: community.url };
    useMarketplace.setState({
      config: config([edited]),
      catalogues: { official: catalogue(edited) },
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
    expect(screen.getByText(official.url)).toBeTruthy();
  });

  it("uses the bound source for manual update confirmation from installed details", async () => {
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Update 2.0.0" }));
    expect(install).not.toHaveBeenCalled();
    const confirmation = useDialogs.getState().dialog;
    if (confirmation.kind !== "confirm") throw new Error("Missing update confirmation");
    expect(confirmation.body).toContain(official.url);
    const pending = deferred<void>();
    install.mockReturnValueOnce(pending.promise);
    expect(confirmation.onConfirm()).toBeUndefined();
    expect(install).toHaveBeenCalledWith(entry, official, true);
    pending.resolve();
  });

  it("blocks runtime and install controls for an unrelated source with the same plugin ID", () => {
    useMarketplace.setState({
      config: config([official, community]),
      catalogues: { community: catalogue(community) },
    });
    render(<PluginDetailPage sourceId="community" pluginId={plugin.id} />);
    expect(
      screen.getByText(
        "This ID is installed from another source. Uninstall it before switching publishers.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Start|Uninstall|Install|Update)/ })).toBeNull();
  });

  it("starts before opening an installed tool and confirms uninstall separately", async () => {
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    fireEvent.click(screen.getByRole("button", { name: "JSON tool" }));
    await waitFor(() =>
      expect(useWorkspace.getState().openPluginView).toHaveBeenCalledWith(
        plugin.id,
        "main",
        "JSON tool",
      ),
    );
    expect(start).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    const confirmation = useDialogs.getState().dialog;
    expect(confirmation.kind === "confirm" && confirmation.danger).toBe(true);
  });

  it("shows cancellation in progress and provides copyable failure details", () => {
    useMarketplace.setState({
      tasks: { formatter: { taskId: "download", phase: "downloading", received: 50, total: 100 } },
      cancelling: [plugin.id],
      taskErrors: { formatter: "Exact failure details" },
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");
    expect(
      (screen.getByRole("button", { name: "Cancelling…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith("Exact failure details");
  });

  it("keeps rounded progress within the available byte total", () => {
    useMarketplace.setState({
      tasks: { formatter: { taskId: "download", phase: "downloading", received: 101, total: 100 } },
    });
    render(<PluginDetailPage sourceId="local" pluginId={plugin.id} />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("100");
    expect(screen.getByText(/100%/)).toBeTruthy();
  });
});
