import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { RegionColors } from "@/features/settings/RegionColors";
import type { PluginInfo, PluginTheme, SettingsPatch } from "@/lib/api/types";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { BUILTIN_THEMES, themePatch } from "@/lib/prefs/themes";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";

const defaults = createDefaultSettings("windows");
const load = vi.fn(async () => {});
const start = vi.fn(async () => {});
const run = vi.fn(async () => {});
const update = vi.fn(async (patch: SettingsPatch) => {
  useSettings.setState((state) => ({ settings: { ...state.settings, ...patch } }));
  return true;
});
const moon: PluginTheme = {
  id: "moon",
  name: "Moon",
  appearance: "dark",
  accent: "cyan",
  colors: { sidebar: "#112233" },
};
const sun: PluginTheme = {
  id: "sun",
  name: "Sun",
  appearance: "light",
  colors: { editor: "#fffabc" },
};
const pack = (themes: PluginTheme[]): PluginInfo => ({
  id: "palette-pack",
  name: "Palette pack",
  author: "Local publisher",
  version: "1.0.0",
  apiVersion: 1,
  description: null,
  commands: [],
  views: [],
  permissions: [],
  status: "stopped",
  error: null,
  runtime: "theme",
  path: "/palette-pack",
  themes,
});
function Harness() {
  const settings = useSettings((state) => state.settings);
  return <RegionColors settings={settings} />;
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useSettings.setState({ settings: { ...defaults, colors: {} }, update });
  usePlugins.setState({ items: [], load, start, run });
});

describe("compact theme choices", () => {
  it("starts with customization collapsed and loads installed theme metadata once", () => {
    const view = render(<Harness />);
    expect(view.container.querySelector("details")?.open).toBe(false);
    expect(screen.getByRole("button", { name: "Sidebar" }).closest("details")?.open).toBe(false);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("applies a complete preset with one update and leaves customization closed", () => {
    useSettings.setState({
      settings: { ...defaults, accent: "violet", colors: { sidebar: "#abcdef" } },
    });
    const view = render(<Harness />);
    const graphite = BUILTIN_THEMES.find((preset) => preset.id === "graphite")!;
    fireEvent.click(screen.getByRole("button", { name: i18n.t("themes.graphite") }));
    expect(update).toHaveBeenCalledExactlyOnceWith(themePatch(graphite));
    expect(
      screen.getByRole("button", { name: i18n.t("themes.graphite") }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(view.container.querySelector("details")?.open).toBe(false);
  });

  it("supports one or several palettes per plugin without starting a runtime", () => {
    usePlugins.setState({ items: [pack([moon])] });
    render(<Harness />);
    expect(screen.getByText("Local publisher")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Moon" }));
    expect(update).toHaveBeenCalledExactlyOnceWith(themePatch(moon));
    act(() => usePlugins.setState({ items: [pack([moon, sun])] }));
    fireEvent.click(screen.getByRole("button", { name: "Sun" }));
    expect(update).toHaveBeenLastCalledWith(themePatch(sun));
    expect(update).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("retains the applied colors when a plugin is removed and clears false selections after edits", () => {
    usePlugins.setState({ items: [pack([moon])] });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Moon" }));
    act(() => usePlugins.setState({ items: [] }));
    expect(useSettings.getState().settings).toMatchObject(themePatch(moon));
    expect(update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(screen.getByText(i18n.t("themes.customized"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("themes.graphite") }));
    act(() =>
      useSettings.setState((state) => ({ settings: { ...state.settings, accent: "orange" } })),
    );
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("expands regional controls without saving and edits only the chosen region", () => {
    useSettings.setState({ settings: { ...defaults, colors: { editor: "#123456" } } });
    const view = render(<Harness />);
    fireEvent.click(screen.getByText(i18n.t("themes.customize")));
    expect(view.container.querySelector("details")?.open).toBe(true);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));
    fireEvent.change(screen.getByRole("textbox", { name: "HEX" }), {
      target: { value: "#abcdef" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(update).toHaveBeenCalledExactlyOnceWith({
      colors: { editor: "#123456", sidebar: "#abcdef" },
    });
  });

  it("selects only one card when installed palettes have identical snapshots", () => {
    usePlugins.setState({ items: [pack([{ ...moon, accent: "blue", colors: {} }])] });
    useSettings.setState({ settings: { ...defaults, theme: "dark" } });
    render(<Harness />);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Moon" }).getAttribute("aria-pressed")).toBe("false");
  });
});
