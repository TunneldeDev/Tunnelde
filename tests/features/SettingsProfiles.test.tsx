import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { SettingsProfiles } from "@/features/settings/SettingsProfiles";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { portableSettings } from "@/lib/prefs/profiles";
import { useSettings } from "@/store/settings";
import { useSettingsProfiles } from "@/store/settingsProfiles";
import { useDialogs } from "@/store/dialogs";
const mocks = vi.hoisted(() => ({
  importSettingsFile: vi.fn(),
  exportSettingsFile: vi.fn(),
  saveSettingsProfile: vi.fn(),
  settingsProfiles: vi.fn(),
  deleteSettingsProfile: vi.fn(),
  setLocale: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, isTauri: () => true }));
const defaults = createDefaultSettings("windows");
const profile = {
  id: "work",
  name: "Work",
  settings: portableSettings({ ...defaults, theme: "light" }),
  updatedAt: 1,
};
const update = vi.fn(async () => true);
const applied = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mocks.settingsProfiles.mockResolvedValue([profile]);
  mocks.saveSettingsProfile.mockResolvedValue([profile]);
  useSettings.setState({
    settings: { ...defaults, skippedVersion: "1.0", lastUpdateCheck: 100 },
    saving: false,
    update,
  });
  useSettingsProfiles.setState({
    profiles: [profile],
    selectedId: "work",
    loading: false,
    busy: false,
    error: null,
  });
  useDialogs.setState({ dialog: { kind: "none" } });
});
const mount = async (hasDraft = false) => {
  await act(async () => render(<SettingsProfiles hasDraft={hasDraft} onApplied={applied} />));
};

describe("settings profile workflows", () => {
  it("exports only applied portable preferences through the native picker", async () => {
    mocks.exportSettingsFile.mockResolvedValue(null);
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Export current settings…" })),
    );
    expect(mocks.exportSettingsFile).toHaveBeenCalledWith(
      "Work",
      portableSettings(useSettings.getState().settings),
    );
    expect(mocks.exportSettingsFile.mock.calls[0]![1]).not.toHaveProperty("skippedVersion");
    expect(mocks.exportSettingsFile.mock.calls[0]![1]).not.toHaveProperty("lastUpdateCheck");
  });

  it("previews imports without changing preferences, then applies through the settings store", async () => {
    mocks.importSettingsFile.mockResolvedValue({
      format: "tunnelde-settings",
      version: 1,
      name: "Imported",
      settings: profile.settings,
    });
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Import settings…" })),
    );
    const dialog = screen.getByRole("dialog", { name: "Review imported settings" });
    expect(within(dialog).getByText("Imported")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Apply" })));
    expect(update).toHaveBeenCalledWith(profile.settings);
    expect(applied).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSettingsProfiles.getState().selectedId).toBeNull();
  });

  it("preserves imported preview and CSS draft while global confirmation takes focus", async () => {
    mocks.importSettingsFile.mockResolvedValue({
      format: "tunnelde-settings",
      version: 1,
      name: "Imported",
      settings: profile.settings,
    });
    await mount(true);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Import settings…" })),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDialogs.getState().dialog.kind).toBe("confirm");
    await act(async () => useDialogs.getState().close());
    expect(screen.getByRole("dialog", { name: "Review imported settings" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(update).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
  });

  it("replaces the manage dialog with rename and restores the management context on cancel", async () => {
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" })),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rename profile" })));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Rename profile" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Manage settings profiles" })).toBeTruthy();
  });

  it("restores management after a successful rename", async () => {
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" })),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rename profile" })));
    fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), {
      target: { value: "Personal" },
    });
    mocks.saveSettingsProfile.mockResolvedValue([{ ...profile, name: "Personal" }]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(mocks.saveSettingsProfile).toHaveBeenCalledWith("work", "Personal", profile.settings);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Manage settings profiles" })).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
  });

  it("rejects duplicate names locally and saves a new profile without runtime metadata", async () => {
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save as profile…" })),
    );
    const input = screen.getByRole("textbox", { name: "Profile name" });
    fireEvent.change(input, { target: { value: " work " } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    expect(mocks.saveSettingsProfile).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Personal" } });
    mocks.saveSettingsProfile.mockResolvedValue([
      profile,
      { ...profile, id: "personal", name: "Personal" },
    ]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(mocks.saveSettingsProfile).toHaveBeenCalledWith(
      null,
      "Personal",
      portableSettings(useSettings.getState().settings),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides management during a destructive confirmation and restores it on cancel", async () => {
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" })),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete Work" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.deleteSettingsProfile).not.toHaveBeenCalled();
    await act(async () => useDialogs.getState().close());
    expect(screen.getByRole("dialog", { name: "Manage settings profiles" })).toBeTruthy();
  });

  it("applies a named profile directly and clears local drafts only after success", async () => {
    await mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" })),
    );
    update.mockResolvedValueOnce(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(applied).not.toHaveBeenCalled();
    expect(useSettingsProfiles.getState().selectedId).toBe("work");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" })),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(update).toHaveBeenLastCalledWith(profile.settings);
    expect(applied).toHaveBeenCalledOnce();
  });
});
