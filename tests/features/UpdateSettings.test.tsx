import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { SettingsPage } from "@/features/settings/SettingsPage";
import {
  UpdateSourceUrl,
  UpdateStatus,
  validUpdateSource,
} from "@/features/settings/UpdateSettings";
import { UpdatePill } from "@/components/layout/UpdatePill";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { AppInfo, SettingsPatch, UpdateState } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { useUpdates } from "@/store/updates";

const mock = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  skip: vi.fn(),
  openReleasePage: vi.fn(),
  native: true,
}));
vi.mock("@/lib/api/ipc", () => ({
  isTauri: () => mock.native,
  api: { openReleasePage: mock.openReleasePage },
}));
vi.mock("@/features/terminal/TerminalPreview", () => ({ TerminalPreview: () => null }));
vi.mock("@/features/settings/SettingsProfiles", () => ({ SettingsProfiles: () => null }));

const defaults = createDefaultSettings("windows");
const update = vi.fn(async (patch: SettingsPatch) => {
  useSettings.setState((store) => ({ settings: { ...store.settings, ...patch } }));
  return true;
});
function state(patch: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: "available",
    currentVersion: "0.26.1",
    channel: "stable",
    source: "github",
    sourceUrl: "",
    version: "0.26.2",
    notes: "## Fixes\n\n- Reconnect terminals.",
    publishedAt: 1000,
    progress: null,
    contentLength: null,
    error: null,
    lastChecked: 2000,
    available: true,
    autoInstall: true,
    unsupportedReason: null,
    downloadUrl: null,
    skipped: false,
    ...patch,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mock.native = true;
  mock.openReleasePage.mockResolvedValue(undefined);
  await i18n.changeLanguage("en-US");
  useSettings.setState({
    settings: { ...defaults },
    info: { version: "0.26.1", os: "windows", defaultSettings: defaults } as AppInfo,
    ready: true,
    saving: false,
    error: null,
    update,
  });
  useUpdates.setState({
    state: null,
    busy: false,
    check: mock.check,
    install: mock.install,
    skip: mock.skip,
  });
  useNavigation.setState({ settingsSection: "updates" });
  useWorkspace.getState().hydrate([]);
});

describe("updates inside settings", () => {
  it("offers separate Stable, Beta and Nightly channels and persists the selection", async () => {
    render(<SettingsPage />);
    const row = within(document.querySelector('[data-setting="updateChannel"]') as HTMLElement);
    fireEvent.click(row.getByRole("button", { name: "Update channel" }));
    expect(screen.getByRole("option", { name: "Stable" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Public beta (Beta)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Development (Nightly)" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ updateChannel: "nightly" }));
    expect(useSettings.getState().settings.updateChannel).toBe("nightly");
    expect(document.querySelector(".settings-update__channel")?.textContent).toBe(
      "Development (Nightly)",
    );
  });

  it("checks inline without opening another page and exposes channel and source preferences", () => {
    render(<SettingsPage />);
    expect(screen.getByText("v0.26.1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(mock.check).toHaveBeenCalledExactlyOnceWith(true);
    expect(useWorkspace.getState().tabs).toEqual([]);
    expect(document.querySelector('[data-setting="updateChannel"]')).toBeTruthy();
    expect(document.querySelector('[data-setting="updateSource"]')).toBeTruthy();
    expect(document.querySelector('[data-setting="updateCheckInterval"]')).toBeTruthy();
    expect(document.querySelector('[data-setting="updateSourceUrl"]')).toBeNull();
  });

  it("routes notification clicks to the existing settings tab", () => {
    useUpdates.setState({ state: state() });
    useWorkspace.getState().openPage("settings");
    useNavigation.setState({ settingsSection: "general" });
    render(<UpdatePill />);
    fireEvent.click(screen.getByRole("button", { name: "0.26.2" }));
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toEqual(["settings"]);
    expect(useNavigation.getState().settingsSection).toBe("updates");
  });

  it("renders collapsible Markdown notes and offers installation even after skipping a notification", () => {
    useUpdates.setState({ state: state({ skipped: true }) });
    render(<UpdateStatus />);
    const details = screen.getByText("Release notes · v0.26.2").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("h2")?.textContent).toBe("Fixes");
    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    expect(mock.install).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Skip this version" })).toBeNull();
  });

  it("invalidates old update actions and notifications when channels or sources change", () => {
    useUpdates.setState({ state: state() });
    render(
      <>
        <UpdateStatus />
        <UpdatePill />
      </>,
    );
    expect(screen.getByRole("button", { name: "Download and install" })).toBeTruthy();
    act(() => useSettings.setState({ settings: { ...defaults, updateChannel: "beta" } }));
    expect(screen.queryByRole("button", { name: "Download and install" })).toBeNull();
    expect(screen.queryByRole("button", { name: "0.26.2" })).toBeNull();
    act(() => useSettings.setState({ settings: { ...defaults, updateSource: "custom" } }));
    expect(
      (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables competing actions during downloading and handles unknown sizes without displaying zero percent", () => {
    useUpdates.setState({ state: state({ phase: "downloading", progress: 4096 }), busy: true });
    render(<UpdateStatus />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("4");
    expect(screen.getByRole("status").textContent).not.toContain("0%");
    expect(
      (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Download and install" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("locks channel and source controls during an installation", () => {
    useUpdates.setState({ state: state({ phase: "downloading" }), busy: true });
    render(<SettingsPage />);
    expect(
      (
        within(document.querySelector('[data-setting="updateChannel"]') as HTMLElement).getByRole(
          "button",
          { name: "Update channel" },
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(document.querySelector('[data-setting="updateSource"]') as HTMLElement).getByRole(
          "button",
          { name: "Update source" },
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows real percentage progress and manual updates for platforms without automatic installation", () => {
    useUpdates.setState({
      state: state({ phase: "downloading", progress: 50, contentLength: 100 }),
      busy: true,
    });
    const { rerender } = render(<UpdateStatus />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    act(() =>
      useUpdates.setState({
        state: state({ autoInstall: false, unsupportedReason: "unsigned" }),
        busy: false,
      }),
    );
    rerender(<UpdateStatus />);
    expect(screen.queryByRole("button", { name: "Download and install" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download manually" }));
    expect(mock.openReleasePage).toHaveBeenCalledOnce();
  });

  it("keeps source typing local until a valid URL is applied", async () => {
    useSettings.setState({ settings: { ...defaults, updateSource: "custom" } });
    render(<UpdateSourceUrl onReset={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Custom source URL" });
    fireEvent.change(input, { target: { value: "http://mirror.example.com/{channel}.json" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "https://mirror.example.com/{channel}.json" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        updateSourceUrl: "https://mirror.example.com/{channel}.json",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["https://example.com/{channel}/latest.json", true],
    ["http://example.com/{channel}.json", false],
    ["https://user:password@example.com/{channel}.json", false],
    ["https://{channel}.example.com/stable.json", false],
    ["https://{channel}.example.com/tunnelde-update-channel/latest.json", false],
    ["https://example.com/latest.json?channel={channel}", false],
    ["https://example.com/{channel}/{channel}.json", false],
    ["https://example.com/{channel}/{target}.json", false],
    ["https://example.com/{channel}.json#fragment", false],
  ])("validates custom source %s", (value, valid) => expect(validUpdateSource(value)).toBe(valid));
});
