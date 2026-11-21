import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { NumberPreference } from "@/features/settings/NumberPreference";
import { CssEditorView } from "@/features/settings/components/CssEditorView";
import { FileIconThemeSettingView } from "@/features/settings/components/FileIconThemeSettingView";
import { HostListSettingsView } from "@/features/settings/components/HostListSettingsView";
import { RegionColorsView } from "@/features/settings/components/RegionColorsView";
import { UpdateSourceUrlView } from "@/features/settings/components/UpdateSourceUrlView";
import { UpdateStatusView } from "@/features/settings/components/UpdateStatusView";
import { UpdateNotesView } from "@/features/settings/components/UpdateNotesView";
import { UpdateDiagnosticsView } from "@/features/settings/components/UpdateDiagnosticsView";
import type { SettingsControlState } from "@/features/settings/components/controlState";
import { updateHistoryKey } from "@/lib/updates/stateIdentity";
import type { UpdateState } from "@/lib/api/types";
import { createDefaultSettings } from "@/lib/prefs/defaults";

vi.mock("@/store/settings", () => {
  throw new Error("Control evaluated the main settings owner");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Control evaluated the main plugin owner");
});
vi.mock("@/store/updates", () => {
  throw new Error("Control evaluated the main update owner");
});
vi.mock("@/store/navigation", () => {
  throw new Error("Control evaluated main navigation");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Control evaluated direct main IPC");
});

const defaults = createDefaultSettings("windows");
const available: UpdateState & { version: string } = {
  phase: "available",
  currentVersion: "2.0.0",
  version: "2.1.0",
  channel: "stable",
  source: "github",
  sourceUrl: "",
  notes: "Current release notes",
  publishedAt: null,
  progress: null,
  contentLength: null,
  error: null,
  lastChecked: 123,
  available: true,
  autoInstall: true,
  unsupportedReason: null,
  downloadUrl: null,
  skipped: false,
};
function capsuleState(): SettingsControlState {
  const retained = new Map<string, unknown>();
  return function useCapsuleState<T>(key: string, initial: T) {
    const [value, setValue] = useState(() =>
      retained.has(key) ? (retained.get(key) as T) : initial,
    );
    retained.set(key, value);
    return [value, setValue];
  };
}
function toggle(details: HTMLDetailsElement, open: boolean) {
  details.open = open;
  fireEvent(details, new Event("toggle"));
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("owner-independent specialized settings controls", () => {
  it("retains incomplete numeric drafts and validation through the supplied view state", () => {
    const useViewState = capsuleState();
    const onChange = vi.fn();
    const props = {
      value: 14,
      min: 8,
      max: 40,
      label: "Font size",
      stateKey: "font",
      useViewState,
      onChange,
    };
    const first = render(<NumberPreference {...props} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    expect(screen.getByRole("spinbutton").getAttribute("aria-invalid")).toBe("true");
    first.unmount();
    const second = render(<NumberPreference {...props} />);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("spinbutton").getAttribute("aria-invalid")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    second.rerender(<NumberPreference {...props} value={16} />);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("16");
    expect(screen.getByRole("spinbutton").getAttribute("aria-invalid")).toBeNull();
  });

  it("retains an invalid update URL without saving it, then delegates a complete valid URL", async () => {
    const useViewState = capsuleState();
    const update = vi.fn(async () => true);
    const props = {
      value: "",
      source: "custom" as const,
      saving: false,
      updatesBusy: false,
      onReset: vi.fn(),
      update,
      useViewState,
    };
    const first = render(<UpdateSourceUrlView {...props} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://unfinished" } });
    first.unmount();
    render(<UpdateSourceUrlView {...props} />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("https://unfinished");
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://updates.example/{channel}/latest.json" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(update).toHaveBeenCalledWith({
      updateSourceUrl: "https://updates.example/{channel}/latest.json",
    });
  });

  it("routes CSS file transfer, saves and notifications through supplied services", async () => {
    const update = vi.fn(async () => true);
    const importFile = vi.fn(async () => ".imported { color: red; }");
    const exportFile = vi.fn(async () => "/isolated/theme.css");
    const notify = vi.fn();
    function Example() {
      const [draft, onDraft] = useState<string | null>(null);
      return (
        <CssEditorView
          {...{ draft, onDraft }}
          value=""
          services={{ update, importFile, exportFile, notify, canTransferFiles: true }}
        />
      );
    }
    render(<Example />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import" })));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      ".imported { color: red; }",
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
    expect(exportFile).toHaveBeenCalledWith(".imported { color: red; }");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/isolated/theme.css"), "success");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(update).toHaveBeenCalledWith({ userCss: ".imported { color: red; }" });
  });

  it("uses explicit theme metadata and delegates region merges to the owner", () => {
    const applyTheme = vi.fn(async () => true),
      changeRegion = vi.fn();
    render(
      <RegionColorsView
        settings={{ ...defaults, colors: { sidebar: "#112233" } }}
        plugins={[]}
        services={{ applyTheme, changeRegion }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("themes.graphite") }));
    expect(applyTheme).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Reset Sidebar" }));
    expect(changeRegion).toHaveBeenCalledWith("sidebar", null);
  });

  it("selects from projected icon themes and preserves host view/reset actions", () => {
    const onChange = vi.fn(),
      onViewChange = vi.fn(),
      onReset = vi.fn();
    render(
      <>
        <FileIconThemeSettingView
          value="missing:theme"
          descriptionId="icons-help"
          themes={[{ id: "icons:code", name: "Code", plugin: "Icons" }]}
          onChange={onChange}
        />
        <HostListSettingsView
          preferences={defaults.hostList}
          onViewChange={onViewChange}
          onReset={onReset}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.fileIconTheme") }));
    fireEvent.click(screen.getByRole("option", { name: "Code · Icons" }));
    expect(onChange).toHaveBeenCalledWith("icons:code");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("hostColumns.view") }));
    fireEvent.click(screen.getByRole("option", { name: i18n.t("hostColumns.table") }));
    expect(onViewChange).toHaveBeenCalledWith("table");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("hostColumns.reset") }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("delegates update actions and notes without a direct update or IPC owner", async () => {
    const check = vi.fn(async () => {}),
      install = vi.fn(async () => {}),
      skip = vi.fn(async () => {}),
      openRelease = vi.fn();
    render(
      <UpdateStatusView
        settings={defaults}
        version="2.0.0"
        saving={false}
        state={available}
        busy={false}
        nativeAvailable
        services={{
          check,
          install,
          skip,
          openRelease,
          renderDiagnostics: () => null,
          renderNotes: () => <div>Owner release notes</div>,
        }}
      />,
    );
    expect(screen.getByText("Owner release notes")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Check for updates" })),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Download and install" })),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Skip this version" })),
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.openRelease") }));
    expect(check).toHaveBeenCalledWith(true);
    expect(install).toHaveBeenCalledOnce();
    expect(skip).toHaveBeenCalledOnce();
    expect(openRelease).toHaveBeenCalledOnce();
  });

  it("does not show stale release history and preserves expanded notes across a remount", () => {
    const useViewState = capsuleState(),
      load = vi.fn(async () => {});
    const props = {
      state: available,
      history: {
        key: updateHistoryKey({ ...available, version: "old" }),
        loading: false,
        error: null,
        data: null,
      },
      services: { load, useViewState, renderMarkdown: (source: string) => <div>{source}</div> },
    };
    const first = render(<UpdateNotesView {...props} />);
    toggle(screen.getByText("Release notes · v2.0.0 → v2.1.0").closest("details")!, true);
    expect(screen.getByText("Current release notes")).toBeTruthy();
    expect(load).toHaveBeenCalled();
    first.unmount();
    render(<UpdateNotesView {...props} />);
    expect(screen.getByText("Current release notes")).toBeTruthy();
  });

  it("routes update diagnostics navigation back through owner callbacks", () => {
    const onConfigureProxy = vi.fn(),
      onShowLogs = vi.fn();
    render(<UpdateDiagnosticsView failures={[]} {...{ onConfigureProxy, onShowLogs }} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.configureProxy") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("updates.showLogs") }));
    expect(onConfigureProxy).toHaveBeenCalledOnce();
    expect(onShowLogs).toHaveBeenCalledOnce();
  });
});
