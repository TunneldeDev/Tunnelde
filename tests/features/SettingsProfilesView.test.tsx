import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  SettingsProfilesView,
  type SettingsProfilesData,
  type SettingsProfilesServices,
} from "@/features/settings/components/SettingsProfilesView";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { portableSettings, type SettingsDocument } from "@/lib/prefs/profiles";

vi.mock("@/store/settings", () => {
  throw new Error("Profiles view imported main settings owner");
});
vi.mock("@/store/settingsProfiles", () => {
  throw new Error("Profiles view imported main profiles owner");
});
vi.mock("@/store/dialogs", () => {
  throw new Error("Profiles view imported main consent owner");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Profiles view imported direct IPC");
});

function fixture() {
  const snapshot = portableSettings(createDefaultSettings("windows"));
  const profile = {
    id: "work",
    name: "Work",
    settings: { ...snapshot, theme: "light" as const },
    updatedAt: 1,
  };
  const data: SettingsProfilesData = {
    snapshot,
    profiles: [profile],
    selectedId: "work",
    revision: "pc1:initial",
    saving: false,
    loading: false,
    busy: false,
    error: null,
    appDialogOpen: false,
    nativeAvailable: true,
  };
  const captured = new Map<string, unknown>();
  const services: SettingsProfilesServices = {
    useData: () => data,
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    readCurrent: () => ({ saving: data.saving, busy: data.busy, revision: data.revision }),
    load: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    saveCurrent: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    confirm: vi.fn(),
    importFile: vi.fn(async () => null),
    exportFile: vi.fn(async () => null),
    notify: vi.fn(),
  };
  const applied = vi.fn();
  const mount = (hasDraft = false) =>
    render(<SettingsProfilesView hasDraft={hasDraft} services={services} onApplied={applied} />);
  const imported: SettingsDocument = {
    format: "tunnelde-settings",
    version: 1,
    name: "Imported",
    settings: profile.settings,
  };
  return { data, services, captured, profile, snapshot, applied, mount, imported };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("settings profiles document-local boundary", () => {
  it("captures the owner revision before consent and delegates only the saved identity", async () => {
    const owner = fixture();
    owner.mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(owner.services.apply).not.toHaveBeenCalled();
    const confirmation = vi.mocked(owner.services.confirm).mock.calls[0]![0];
    owner.data.revision = "pc1:changed";
    await act(async () => confirmation.onConfirm());
    expect(owner.services.apply).toHaveBeenCalledWith({
      source: "saved",
      id: "work",
      revision: "pc1:initial",
    });
    expect(owner.applied).toHaveBeenCalledOnce();
  });

  it("keeps an imported preview across capture/remount and clears drafts only after successful apply", async () => {
    const owner = fixture();
    vi.mocked(owner.services.importFile).mockResolvedValue(owner.imported);
    const view = owner.mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Import settings…" })),
    );
    expect(owner.services.apply).not.toHaveBeenCalled();
    view.unmount();
    owner.mount();
    const dialog = screen.getByRole("dialog", { name: "Review imported settings" });
    expect(within(dialog).getByText("Imported")).toBeTruthy();
    vi.mocked(owner.services.apply).mockResolvedValueOnce(false);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Apply" })));
    expect(owner.applied).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Review imported settings" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(owner.services.apply).toHaveBeenLastCalledWith({
      source: "import",
      settings: owner.imported.settings,
    });
    expect(owner.applied).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retains a naming draft and management context across remount", () => {
    const owner = fixture();
    const view = owner.mount();
    fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename profile" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), {
      target: { value: "Personal draft" },
    });
    view.unmount();
    owner.mount();
    expect((screen.getByRole("textbox", { name: "Profile name" }) as HTMLInputElement).value).toBe(
      "Personal draft",
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Manage settings profiles" })).toBeTruthy();
    expect(owner.services.save).not.toHaveBeenCalled();
  });

  it("updates through saveCurrent after consent rather than submitting a stale rendered body", async () => {
    const owner = fixture();
    owner.mount();
    fireEvent.click(screen.getByRole("button", { name: "Update profile" }));
    expect(owner.services.saveCurrent).not.toHaveBeenCalled();
    owner.data.snapshot = { ...owner.snapshot, theme: "dark" };
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.services.saveCurrent).toHaveBeenCalledWith("work", "Work");
    expect(owner.services.save).not.toHaveBeenCalled();
  });

  it("does not apply a saved profile without an owner revision or while owner is busy", async () => {
    const owner = fixture();
    owner.data.revision = null;
    owner.mount();
    fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(owner.services.apply).not.toHaveBeenCalled();
    expect(owner.services.notify).toHaveBeenCalledWith(i18n.t("profiles.conflict"), "error");
    fireEvent.click(screen.getByRole("button", { name: "Manage settings profiles" }));
    owner.data.busy = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(owner.services.apply).not.toHaveBeenCalled();
  });

  it("keeps cancellation silent and reports chooser failures through the owner", async () => {
    const owner = fixture();
    owner.mount();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Import settings…" })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(owner.services.notify).not.toHaveBeenCalled();
    vi.mocked(owner.services.importFile).mockRejectedValueOnce(
      new Error("Fixture chooser unavailable"),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Import settings…" })),
    );
    expect(owner.services.notify).toHaveBeenCalledWith("Fixture chooser unavailable", "error");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Export current settings…" })),
    );
    expect(owner.services.exportFile).toHaveBeenCalledWith("Work", owner.snapshot);
    expect(owner.services.notify).toHaveBeenCalledTimes(1);
  });
});
