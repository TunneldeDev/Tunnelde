import "@/i18n/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsWindowContent } from "@/features/settings/window/SettingsWindowContent";
import { SettingsDraftScope } from "@/features/settings/window/SettingsDraftScope";
import type { SettingsProjection } from "@/features/settings/window/model";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { portableSettings } from "@/lib/prefs/profiles";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { ComponentProps } from "react";
import type { PreferenceSurfaceServices } from "@/features/settings/components/PreferenceSurfaceView";
import i18n from "@/i18n/i18n";
// xterm requires real browser font/layout APIs, covered by native acceptance.
vi.mock("@/features/terminal/TerminalPreview", () => ({
  TerminalPreview: () => <div data-testid="terminal-preview" />,
}));
const defaults = createDefaultSettings("macos");
function projection(): SettingsProjection {
  return {
    page: {
      settings: defaults,
      defaults,
      platform: "macos",
      plugins: [],
      error: null,
      saving: false,
      updatesBusy: false,
      section: "general",
      settingsRequest: 9,
      shortcutRequest: 0,
    },
    profiles: {
      snapshot: portableSettings(defaults),
      profiles: [],
      selectedId: null,
      revision: "profiles",
      loading: false,
      busy: false,
      saving: false,
      error: null,
      appDialogOpen: false,
      nativeAvailable: true,
    },
    storage: {
      status: null,
      loading: false,
      busy: false,
      error: null,
      draft: [],
      nativeAvailable: true,
    },
    shortcuts: {
      definitions: [],
      plugins: [],
      overrides: {},
      rules: {},
      showDetails: false,
      saving: false,
      query: "",
    },
    sources: { sources: [], configError: null, configLoading: false, ready: true },
    security: {
      state: {
        restricted: false,
        cliLocked: false,
        recoverySuggested: false,
        reason: null,
        grants: {},
      },
      ready: true,
      loading: false,
      busy: false,
      error: null,
      failure: null,
      recoveryDismissed: false,
      plugins: [],
    },
    node: {
      info: null,
      busy: null,
      error: null,
      progress: null,
      cancelling: false,
      nativeAvailable: true,
    },
    providers: { rows: [], busy: false },
    mountContributor: { value: "", candidates: [], unavailableName: "", busy: false },
    recoveryFiles: { pending: false, error: null },
    plugins: [],
    info: { version: "2.0.0", tauriVersion: "2", os: "macos", arch: "aarch64" },
    update: { state: null, busy: false, history: null },
    configurationChanges: [],
  };
}
function Provider({ children }: ComponentProps<PreferenceSurfaceServices["Provider"]>) {
  return <>{children}</>;
}
function fixture(initial?: unknown, staged = false) {
  const controller = createPanelViewState(initial);
  const record: WindowViewRecord = {
    key: crypto.randomUUID(),
    panelId: "settings-view:test",
    controller,
    staged,
    lease: { panelId: "settings-view:test", windowId: "satellite", generation: 4 },
  };
  useWindowViews.setState({ entries: new Map([[record.panelId, record]]) });
  const action = vi.fn(async (_lease: unknown, request: { command: { operation: string } }) =>
    request.command.operation === "recovery_owners" ? { ids: [], limited: false } : null,
  );
  const control = vi.fn(async (request: { action: string }) =>
    request.action === "readSettingsPassword" ? "retained-private" : null,
  );
  const client = { action, control } as unknown as PanelWindowClient;
  const data = projection();
  const display = (model = data, Presentation = Provider) => (
    <PanelViewStateScope controller={controller}>
      <SettingsDraftScope client={client} record={record}>
        <SettingsWindowContent
          client={client}
          record={record}
          model={model}
          Provider={Presentation}
        />
      </SettingsDraftScope>
    </PanelViewStateScope>
  );
  return { controller, record, data, display, action, control };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
describe("complete production native Settings composition", () => {
  it("roundtrips query after explicit navigation, without treating remount as a new request", async () => {
    const f = fixture();
    const view = render(f.display());
    const search = await screen.findByRole("textbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "@section:editor" } });
    const capsule = await f.controller.captureAsync(new AbortController().signal);
    view.unmount();
    const restored = fixture(capsule, true);
    render(restored.display());
    expect(
      ((await screen.findByRole("textbox", { name: "Search settings" })) as HTMLInputElement).value,
    ).toBe("@section:editor");
    expect(restored.action).not.toHaveBeenCalled();
  });
  it("preserves the actual private proxy password and every ordinary draft across section changes", async () => {
    const f = fixture();
    f.data.page.section = "network";
    const view = render(f.display());
    await screen.findByRole("textbox", { name: "Search settings" });
    // Complete shared section is present, not a replacement summary.
    expect(document.querySelector(".network-settings")).toBeTruthy();
    await act(async () => {
      view.rerender(f.display({ ...f.data, page: { ...f.data.page, section: "terminal" } }));
    });
    expect(screen.getByTestId("terminal-preview")).toBeTruthy();
    const serialized = JSON.stringify(
      await f.controller.captureAsync(new AbortController().signal),
    );
    expect(serialized).not.toContain("retained-private");
    expect(f.control).toHaveBeenCalledWith(
      expect.objectContaining({ action: "writeSettingsPassword", value: "retained-private" }),
    );
  });
  it("renders plugin security, sources, runtime and recovery in the actual plugins section", async () => {
    const f = fixture();
    f.data.page.section = "plugins";
    const view = render(f.display());
    await screen.findByRole("textbox", { name: "Search settings" });
    const recovery = document.querySelector<HTMLDetailsElement>(".runner-recovery details")!;
    expect(recovery).toBeTruthy();
    fireEvent.click(recovery.querySelector("summary")!);
    await waitFor(() =>
      expect(f.action).toHaveBeenCalledWith(
        f.record.lease,
        expect.objectContaining({ command: { operation: "recovery_owners", args: [] } }),
      ),
    );
    const names = f.action.mock.calls.map(([, request]) => request.command.operation);
    expect(names).toEqual(
      expect.arrayContaining(["sources_load", "security_load", "node_load", "recovery_owners"]),
    );
    expect(document.querySelector(".network-settings")).toBeNull();
    const loads = names.filter((name) => name.endsWith("_load"));
    await act(async () =>
      view.rerender(f.display({ ...f.data, node: { ...f.data.node, error: "probe failed" } })),
    );
    expect(
      f.action.mock.calls
        .map(([, request]) => request.command.operation)
        .filter((name) => name.endsWith("_load")),
    ).toEqual(loads);
  });
});
