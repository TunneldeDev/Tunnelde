import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { NumberPreference } from "@/features/settings/NumberPreference";
import { SETTINGS_CATALOG } from "@/features/settings/catalog";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { AppInfo, SettingsPatch } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";

vi.mock("@/features/terminal/TerminalPreview", () => ({ TerminalPreview: () => null }));

const defaults = createDefaultSettings("windows");
const update = vi.fn(async (patch: SettingsPatch) => {
  useSettings.setState((state) => ({ settings: { ...state.settings, ...patch } }));
  return true;
});
const reset = vi.fn(async () => {
  useSettings.setState({ settings: defaults });
});
const row = (key: string) => {
  const element = document.querySelector<HTMLElement>(`[data-setting="${key}"]`);
  if (!element) throw new Error(`Missing setting ${key}`);
  return within(element);
};
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useSettings.setState({
    settings: { ...defaults },
    info: { os: "windows", defaultSettings: defaults } as AppInfo,
    ready: true,
    saving: false,
    error: null,
    update,
    reset,
  });
  useNavigation.setState({ settingsSection: "general" });
  useDialogs.setState({ dialog: { kind: "none" } });
});

describe("settings discovery and scoped resets", () => {
  it("defaults bandwidth limits to unlimited and keeps them available without optimization", () => {
    useNavigation.setState({ settingsSection: "files" });
    render(<SettingsPage />);
    const upload = row("transferUploadLimitKib").getByRole("spinbutton") as HTMLInputElement;
    const download = row("transferDownloadLimitKib").getByRole("spinbutton") as HTMLInputElement;
    expect(upload.value).toBe("0");
    expect(download.value).toBe("0");
    fireEvent.click(row("transferOptimization").getByRole("switch"));
    expect(upload.disabled).toBe(false);
    expect(download.disabled).toBe(false);
    fireEvent.change(upload, { target: { value: "512" } });
    fireEvent.keyDown(upload, { key: "Enter" });
    expect(update).toHaveBeenCalledWith({ transferUploadLimitKib: 512 });
  });

  it("groups transfer optimization settings with automatic choices and disables overrides when off", async () => {
    useNavigation.setState({ settingsSection: "files" });
    render(<SettingsPage />);
    expect(document.querySelector('[data-settings-group="transfers"]')).toBeTruthy();
    expect(row("transferOptimization").getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    const concurrency = row("transferConcurrency").getByRole("button", {
      name: "Concurrent segments",
    });
    expect(concurrency.textContent).toContain("Automatic");
    fireEvent.click(concurrency);
    expect(screen.getByRole("option", { name: "Automatic" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("option", { name: "4" })));
    expect(update).toHaveBeenLastCalledWith({ transferConcurrency: 4 });
    await act(async () => fireEvent.click(row("transferOptimization").getByRole("switch")));
    expect(
      row("transferConcurrency")
        .getByRole("button", { name: "Concurrent segments" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      row("transferChunkKib")
        .getByRole("button", { name: "Segment size" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      row("transferRequests")
        .getByRole("button", { name: "SFTP requests per segment" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(useSettings.getState().settings.transferConcurrency).toBe(4);
  });
  it("offers direct host connection with an enabled default and persists turning it off", async () => {
    useNavigation.setState({ settingsSection: "workspace" });
    render(<SettingsPage />);
    const toggle = row("hostDirectConnect").getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(update).toHaveBeenLastCalledWith({ hostDirectConnect: false });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  it.each(["windows", "linux", "macos"])(
    "shows the background Dock preference only on macOS (%s)",
    async (os) => {
      const platformDefaults = createDefaultSettings(os);
      useSettings.setState({
        settings: platformDefaults,
        info: { os, defaultSettings: platformDefaults } as AppInfo,
      });
      render(<SettingsPage />);
      expect(Boolean(document.querySelector('[data-setting="closeToTray"]'))).toBe(os !== "macos");
      if (os !== "macos") {
        expect(document.querySelector('[data-setting="showDockIconInBackground"]')).toBeNull();
        return;
      }
      const toggle = row("showDockIconInBackground").getByRole("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await act(async () => fireEvent.click(toggle));
      expect(update).toHaveBeenLastCalledWith({ showDockIconInBackground: false });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      await act(async () => fireEvent.click(row("showDockIconInBackground").getByRole("button")));
      expect(update).toHaveBeenLastCalledWith({ showDockIconInBackground: true });
    },
  );

  it("places the labelled terminal preview inside display settings and navigates to that parent", async () => {
    useNavigation.setState({ settingsSection: "terminal" });
    await act(async () => {
      render(<SettingsPage />);
    });
    const category = screen
      .getByRole("heading", { name: "Terminal", level: 2 })
      .closest("section")!;
    const rendering = screen.getByRole("heading", {
      name: "Display and rendering",
      level: 3,
    }).parentElement!;
    const preview = screen.getByRole("group", { name: "Terminal preview" });
    expect(category.contains(rendering)).toBe(true);
    expect(rendering.contains(preview)).toBe(true);
    expect(
      within(preview).getByRole("heading", { name: "Terminal preview", level: 4 }),
    ).toBeTruthy();
    expect(preview.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(preview.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("line spacing");
    expect(rendering.querySelector('[data-setting="terminalLineHeight"]')).toBeTruthy();
    expect(rendering.querySelector('[data-setting="terminalCursorStyle"]')).toBeNull();
    const scroll = vi.fn();
    rendering.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("button", { name: "Display and rendering" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(useNavigation.getState().settingsSection).toBe("terminal");
  });

  it("keeps terminal search and modified-only results focused on matching preferences", () => {
    useSettings.setState({ settings: { ...defaults, terminalLineHeight: 1.5 } });
    useNavigation.setState({ settingsSection: "terminal" });
    render(<SettingsPage />);
    const search = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "显示与渲染" } });
    expect(screen.getByRole("heading", { name: "Display and rendering", level: 3 })).toBeTruthy();
    expect(row("terminalLineHeight")).toBeTruthy();
    expect(row("terminalRenderer")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Terminal preview" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("group", { name: "Terminal preview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(document.querySelectorAll("[data-setting]")).toHaveLength(1);
    expect(row("terminalLineHeight")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Terminal preview" })).toBeNull();
  });

  it("keeps related settings in inline groups and navigates within the current category", () => {
    useNavigation.setState({ settingsSection: "files" });
    render(<SettingsPage />);
    const preloading = screen.getByRole("heading", { name: "Preloading", level: 3 }).parentElement!;
    expect(preloading.querySelector('[data-setting="preloadDirs"]')).toBeTruthy();
    expect(preloading.querySelector('[data-setting="preloadCount"]')).toBeTruthy();
    expect(preloading.querySelector('[data-setting="filesSortBy"]')).toBeNull();
    const scroll = vi.fn();
    preloading.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("button", { name: "Preloading" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(useNavigation.getState().settingsSection).toBe("files");
    expect(document.querySelectorAll(".settings-section")).toHaveLength(1);
    const body = document.querySelector(".settings__body")!;
    body.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(body.scrollTop).toBe(0);
    expect(screen.getByRole("heading", { name: "Typography", level: 3 })).toBeTruthy();
  });

  it("searches group names in both languages and retains each matching setting once", () => {
    render(<SettingsPage />);
    const search = screen.getByRole("textbox", { name: "Search settings" });
    for (const value of ["preloading", "预加载"]) {
      fireEvent.change(search, { target: { value } });
      expect(document.querySelectorAll("[data-setting]")).toHaveLength(3);
      expect(row("preloadDirs")).toBeTruthy();
      expect(row("preloadCount")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Preloading", level: 3 })).toBeTruthy();
    }
  });

  it("catalogs every editable preference once with real bilingual labels", () => {
    const keys = SETTINGS_CATALOG.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(
      Object.keys(defaults)
        .filter((key) => !["lastUpdateCheck", "skippedVersion"].includes(key))
        .sort(),
    );
    for (const language of ["en-US", "zh-CN"]) {
      for (const item of SETTINGS_CATALOG) {
        expect(i18n.exists(item.label, { lng: language }), item.label).toBe(true);
        if (item.hint) expect(i18n.exists(item.hint, { lng: language }), item.hint).toBe(true);
        for (const option of item.options ?? []) {
          if (!option.literal)
            expect(i18n.exists(option.label, { lng: language }), option.label).toBe(true);
        }
      }
    }
  });

  it("discovers the dedicated shortcuts editor through settings search and navigation", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("shortcuts.title") }));
    expect(document.querySelector('[data-setting="keyboardShortcuts"]')).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Search commands or shortcuts" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "keyboardShortcuts" },
    });
    expect(document.querySelector('[data-setting="keyboardShortcuts"]')).not.toBeNull();
    expect(document.querySelector('[data-setting="theme"]')).toBeNull();
  });

  it("searches Chinese and English across categories and raw preference names", () => {
    render(<SettingsPage />);
    const search = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "灵敏度" } });
    expect(row("terminalScrollSensitivity")).toBeTruthy();
    expect(document.querySelector('[data-setting="language"]')).toBeNull();
    fireEvent.change(search, { target: { value: "editorWordWrap" } });
    expect(row("editorWordWrap")).toBeTruthy();
    fireEvent.change(search, { target: { value: "terminal background" } });
    expect(row("colors").getByRole("button", { name: "Terminal background" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "终端背景" } });
    expect(row("colors")).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzzz-no-setting" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("compares modified preferences with native platform defaults and resets just one", () => {
    useSettings.setState({ settings: { ...defaults, monoFontSize: 18, filesShowHidden: true } });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(document.querySelectorAll("[data-setting]").length).toBe(2);
    fireEvent.click(row("monoFontSize").getByRole("button"));
    expect(update).toHaveBeenLastCalledWith({ monoFontSize: 14 });
    expect(useSettings.getState().settings.filesShowHidden).toBe(true);
    expect(document.querySelector('[data-setting="monoFontSize"]')).toBeNull();
    expect(document.querySelector('[data-setting="titleBarStyle"]')).toBeNull();
  });

  it("confirms category reset and preserves preferences from other categories", async () => {
    useSettings.setState({ settings: { ...defaults, filesShowHidden: true, monoFontSize: 18 } });
    useNavigation.setState({ settingsSection: "files" });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reset category" }));
    expect(update).not.toHaveBeenCalled();
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind !== "confirm") throw new Error("Missing confirmation");
    await act(async () => {
      await dialog.onConfirm();
    });
    expect(useSettings.getState().settings.filesShowHidden).toBe(false);
    expect(useSettings.getState().settings.monoFontSize).toBe(18);
    expect(Object.keys(update.mock.calls[0]![0])).toEqual(
      SETTINGS_CATALOG.filter((item) => item.section === "files").map((item) => item.key),
    );
  });

  it("ignores equivalent color maps in the modified filter and resets colors as one preference", () => {
    useSettings.setState({ settings: { ...defaults, colors: {} } });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(document.querySelectorAll("[data-setting]").length).toBe(0);
    act(() => useSettings.setState({ settings: { ...defaults, colors: { sidebar: "#123456" } } }));
    const colorsRow = document.querySelector('[data-setting="colors"]')!;
    const aggregateReset = colorsRow.querySelector<HTMLButtonElement>(
      ".settings-row__control .settings-reset",
    )!;
    fireEvent.click(aggregateReset);
    expect(update).toHaveBeenLastCalledWith({ colors: {} });
    expect(document.querySelectorAll("[data-setting]").length).toBe(0);
  });

  it("saves region colors once on Apply, merges the latest map, and deletes just one override on reset", () => {
    useSettings.setState({ settings: { ...defaults, colors: { sidebar: "#123456" } } });
    useNavigation.setState({ settingsSection: "appearance" });
    render(<SettingsPage />);
    fireEvent.click(row("colors").getByText(i18n.t("themes.customize")));
    fireEvent.click(row("colors").getByRole("button", { name: "Sidebar" }));
    fireEvent.change(screen.getByRole("textbox", { name: "HEX" }), {
      target: { value: "#abcdef" },
    });
    expect(update).not.toHaveBeenCalled();
    act(() =>
      useSettings.setState({
        settings: { ...defaults, colors: { sidebar: "#123456", editor: "#654321" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(update).toHaveBeenCalledExactlyOnceWith({
      colors: { sidebar: "#abcdef", editor: "#654321" },
    });
    fireEvent.click(row("colors").getByRole("button", { name: "Reset Sidebar" }));
    expect(update).toHaveBeenLastCalledWith({ colors: { editor: "#654321" } });
  });

  it("updates inherited region chips immediately when the system color scheme changes", () => {
    let light = false;
    const listeners = new Set<() => void>();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(
      () =>
        ({
          get matches() {
            return light;
          },
          addEventListener: (_event: string, callback: () => void) => listeners.add(callback),
          removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback),
        }) as unknown as MediaQueryList,
    );
    try {
      useNavigation.setState({ settingsSection: "appearance" });
      const view = render(<SettingsPage />);
      fireEvent.click(row("colors").getByText(i18n.t("themes.customize")));
      const trigger = row("colors").getByRole("button", { name: "Terminal background" });
      expect(trigger.textContent).toContain("#070B12");
      act(() => {
        light = true;
        listeners.forEach((callback) => callback());
      });
      expect(trigger.textContent).toContain("#F8FAFD");
      view.unmount();
      expect(listeners.size).toBe(0);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("restores theme inheritance when Reset color is applied inside the region picker", () => {
    useSettings.setState({
      settings: { ...defaults, colors: { sidebar: "#123456", editor: "#654321" } },
    });
    useNavigation.setState({ settingsSection: "appearance" });
    render(<SettingsPage />);
    fireEvent.click(row("colors").getByText(i18n.t("themes.customize")));
    fireEvent.click(row("colors").getByRole("button", { name: "Sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset color" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(update).toHaveBeenCalledExactlyOnceWith({ colors: { editor: "#654321" } });
  });

  it("disables prefetch count while prefetch is off", () => {
    useSettings.setState({ settings: { ...defaults, preloadDirs: false } });
    useNavigation.setState({ settingsSection: "files" });
    render(<SettingsPage />);
    expect((row("preloadCount").getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
  });

  it("clears invalid numeric drafts even when a category reset leaves that value unchanged", async () => {
    useSettings.setState({ settings: { ...defaults, theme: "dark" } });
    useNavigation.setState({ settingsSection: "appearance" });
    render(<SettingsPage />);
    const input = row("monoFontSize").getByRole("spinbutton");
    const description = input.getAttribute("aria-describedby");
    expect(document.getElementById(description!)?.textContent).toContain("10–32");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset category" }));
    const dialog = useDialogs.getState().dialog;
    if (dialog.kind !== "confirm") throw new Error("Missing confirmation");
    await act(async () => {
      await dialog.onConfirm();
    });
    expect((row("monoFontSize").getByRole("spinbutton") as HTMLInputElement).value).toBe("14");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retains CSS drafts across category switches and later edits during a pending save", async () => {
    useNavigation.setState({ settingsSection: "advanced" });
    let finish!: (ok: boolean) => void;
    update.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Custom CSS" }), {
      target: { value: ":root { --test: blue; }" },
    });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings" })).getByRole("button", {
        name: "General",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings" })).getByRole("button", {
        name: "Advanced",
      }),
    );
    expect(
      (screen.getByRole("textbox", { name: "Custom CSS" }) as HTMLTextAreaElement).value,
    ).toContain("blue");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom CSS" }), {
      target: { value: ":root { --test: red; }" },
    });
    await act(async () => finish(true));
    expect(
      (screen.getByRole("textbox", { name: "Custom CSS" }) as HTMLTextAreaElement).value,
    ).toContain("red");
    expect(update).toHaveBeenCalledWith({ userCss: ":root { --test: blue; }" });
  });

  it("requires confirmation before resetting all preferences", async () => {
    useNavigation.setState({ settingsSection: "advanced" });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reset all settings" }));
    expect(reset).not.toHaveBeenCalled();
    const dialog = useDialogs.getState().dialog;
    if (dialog.kind !== "confirm") throw new Error("Missing confirmation");
    await act(async () => {
      await dialog.onConfirm();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("numeric preference drafts", () => {
  it("does not save partial/invalid input; Enter and blur commit complete values", () => {
    const onChange = vi.fn();
    render(<NumberPreference value={14} min={10} max={32} label="Font" onChange={onChange} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "18" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(18);
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(20);
  });

  it("Escape discards a draft and external reset clears invalid text", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NumberPreference value={18} min={10} max={32} label="Font" onChange={onChange} />,
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    rerender(<NumberPreference value={14} min={10} max={32} label="Font" onChange={onChange} />);
    expect(input.value).toBe("14");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(input.value).toBe("14");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects excessive decimal precision without silently rounding", () => {
    const onChange = vi.fn();
    render(
      <NumberPreference
        value={1.2}
        min={1}
        max={1.8}
        step={0.1}
        label="Line height"
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1.25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(1.5);
  });
});
