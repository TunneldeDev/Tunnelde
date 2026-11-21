import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { SettingsPageView } from "@/features/settings/SettingsPageView";
import { PreferenceRowView } from "@/features/settings/components/PreferenceRowView";
import type {
  SettingsPageData,
  SettingsPageServices,
} from "@/features/settings/settingsPageServices";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { SettingsSection } from "@/store/navigation";

// The production view must be usable without evaluating main-document owners.
vi.mock("@/store/settings", () => {
  throw new Error("Settings view imported main settings owner");
});
vi.mock("@/store/navigation", () => {
  throw new Error("Settings view imported main navigation owner");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Settings view imported main plugin owner");
});
vi.mock("@/store/updates", () => {
  throw new Error("Settings view imported main update owner");
});
vi.mock("@/store/dialogs", () => {
  throw new Error("Settings view imported main consent owner");
});

function fixture(section: SettingsSection = "general") {
  const defaults = createDefaultSettings("windows");
  const data: SettingsPageData = {
    settings: { ...defaults },
    defaults,
    platform: "windows",
    plugins: [],
    error: null,
    saving: false,
    updatesBusy: false,
    section,
    settingsRequest: 0,
    shortcutRequest: 0,
  };
  const update = vi.fn<SettingsPageServices["update"]>(async () => true);
  const reset = vi.fn(async () => {});
  const confirm = vi.fn<SettingsPageServices["confirm"]>();
  const selectSection = vi.fn();
  const renderProfiles = vi.fn<SettingsPageServices["renderProfiles"]>(() => null);
  const rowServices = {
    update,
    updatesBusy: false,
    renderColors: () => <div data-testid="colors" />,
    renderFileIcons: () => <div data-testid="file-icons" />,
  };
  const services: SettingsPageServices = {
    useData: () => data,
    useViewState<T>(_key: string, initial: T) {
      return useState(initial);
    },
    update,
    reset,
    confirm,
    selectSection,
    renderProfiles,
    renderSpecial: (kind) => <div data-testid={`special-${kind}`} />,
    renderConfiguration: (props) => <div data-testid="configuration" hidden={props.hidden} />,
    renderPreferenceSurface: ({ children }) => children,
    renderProtectedRow: (props) => (
      <div data-testid="protected-row">
        <PreferenceRowView {...props} services={rowServices} />
      </div>
    ),
    fields: {
      renderTerminalPreview: () => <div data-testid="terminal-preview" />,
      renderUpdateSource: () => <div data-testid="update-source" />,
      renderHostList: () => <div data-testid="host-list" />,
      renderCss: ({ draft, onDraft }) => (
        <textarea
          aria-label="Owner CSS draft"
          value={draft ?? data.settings.userCss}
          onChange={(event) => onDraft(event.target.value)}
        />
      ),
      renderRow: (props) => <PreferenceRowView {...props} services={rowServices} />,
    },
  };
  return { data, services, update, reset, confirm, selectSection, renderProfiles };
}
function setting(key: string) {
  const element = document.querySelector<HTMLElement>(`[data-setting="${key}"]`);
  if (!element) throw new Error(`Missing setting ${key}`);
  return within(element);
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("document-local production settings renderer boundary", () => {
  it("routes edits and confirmed resets only through supplied effects", async () => {
    const owner = fixture();
    owner.data.settings.releaseWebviewInTray = !owner.data.defaults.releaseWebviewInTray;
    render(<SettingsPageView services={owner.services} />);
    await act(async () => fireEvent.click(setting("releaseWebviewInTray").getByRole("switch")));
    expect(owner.update).toHaveBeenLastCalledWith({
      releaseWebviewInTray: owner.data.defaults.releaseWebviewInTray,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset category" }));
    expect(owner.confirm).toHaveBeenCalledOnce();
    expect(owner.update).toHaveBeenCalledTimes(1);
    const confirmation = owner.confirm.mock.calls[0]?.[0];
    if (!confirmation) throw new Error("Missing owner reset confirmation");
    await act(async () => confirmation.onConfirm());
    expect(owner.update.mock.calls.at(-1)?.[0]).toMatchObject({
      language: owner.data.defaults.language,
      releaseWebviewInTray: owner.data.defaults.releaseWebviewInTray,
    });
  });

  it("preserves CSS drafts in injected view state until an owner-applied profile clears them", () => {
    const owner = fixture("advanced");
    render(<SettingsPageView services={owner.services} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Owner CSS draft" }), {
      target: { value: ".draft { color: red; }" },
    });
    expect(owner.renderProfiles.mock.lastCall?.[0].hasDraft).toBe(true);
    expect(owner.update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "@id:userCss" },
    });
    expect(
      (screen.getByRole("textbox", { name: "Owner CSS draft" }) as HTMLTextAreaElement).value,
    ).toContain(".draft");
    act(() => owner.renderProfiles.mock.lastCall?.[0].onApplied());
    expect(owner.renderProfiles.mock.lastCall?.[0].hasDraft).toBe(false);
  });

  it("keeps every specialized production section and protected consent row explicit", () => {
    const owner = fixture("plugins");
    const view = render(<SettingsPageView services={owner.services} />);
    for (const kind of ["plugins", "uiProviders", "mountHostDetails"])
      expect(screen.getByTestId(`special-${kind}`)).toBeTruthy();
    for (const section of ["network", "shortcuts", "updates", "about", "advanced"] as const) {
      owner.data.section = section;
      view.rerender(<SettingsPageView services={owner.services} />);
      for (const kind of section === "advanced" ? ["storage", "logs"] : [section])
        expect(screen.getByTestId(`special-${kind}`)).toBeTruthy();
    }
    owner.data.section = "editor";
    view.rerender(<SettingsPageView services={owner.services} />);
    expect(
      screen.getByTestId("protected-row").querySelector('[data-setting="editorDraftRecovery"]'),
    ).toBeTruthy();
  });

  it("delegates navigation and preserves filters until an explicit owner navigation request", () => {
    const owner = fixture();
    const view = render(<SettingsPageView services={owner.services} />);
    const search = screen.getByRole("textbox", { name: "Search settings" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "@section:editor" } });
    view.rerender(<SettingsPageView services={owner.services} />);
    expect(search.value).toBe("@section:editor");
    owner.data.settingsRequest += 1;
    view.rerender(<SettingsPageView services={owner.services} />);
    expect(search.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Network & proxies" }));
    expect(owner.selectSection).toHaveBeenCalledWith("network");
  });
});
