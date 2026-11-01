// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

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

  it("searches Chinese and English across categories and raw preference names", () => {
    render(<SettingsPage />);
    const search = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "灵敏度" } });
    expect(row("terminalScrollSensitivity")).toBeTruthy();
    expect(document.querySelector('[data-setting="language"]')).toBeNull();
    fireEvent.change(search, { target: { value: "editorWordWrap" } });
    expect(row("editorWordWrap")).toBeTruthy();
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
