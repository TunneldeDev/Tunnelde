import "@/i18n/i18n";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SettingsProviderScope,
  WindowPreferencesProvider,
} from "@/features/settings/window/WindowPreferencesProvider";
import { PreferenceSurfaceView } from "@/features/settings/components/PreferenceSurfaceView";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { createNativePluginViewClient } from "@/lib/panels/windowPluginClient";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { NativeForwardingProviderDescriptor } from "@/lib/panels/windowProtocol";
import type { FrontendModule, FrontendViewProps } from "@/lib/extensions/uiSdk";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (id: string) => `https://native/${id}`,
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of disposals.splice(0)) stop();
  useWindowViews.setState({ entries: new Map() });
  usePanelWindows.setState({ available: false });
});
function fixture(initial?: unknown, staged = false) {
  const activate = vi.fn(),
    restore = vi.fn();
  let observed: FrontendViewProps["preferences"];
  const createView = vi.fn(() => {
    let draft = "seed";
    return {
      component: function Provider({ preferences }: FrontendViewProps) {
        observed = preferences;
        const [value, setValue] = useState(draft);
        const Fields = preferences!.Fields;
        return (
          <>
            <input
              aria-label="Provider draft"
              value={value}
              onChange={(e) => {
                draft = e.target.value;
                setValue(draft);
              }}
            />
            <Fields />
          </>
        );
      },
      captureState: () => ({ draft }),
      restoreState(value: unknown) {
        restore(value);
        draft = (value as { draft: string }).draft;
      },
      dispose: vi.fn(),
    };
  });
  const module: FrontendModule = { activate, createView };
  const descriptor: NativeForwardingProviderDescriptor = {
    selectionRevision: 8,
    capabilities: { write: true },
    view: {
      pluginId: "preferences",
      runtimeId: "runtime",
      generation: 2,
      viewId: "settings",
      entry: "index.mjs",
      sdkVersion: "0.1.0",
      title: "Settings",
      allowFloating: true,
    },
  };
  let serial = 0;
  const invoke = vi.fn(
    async (_command: string, { request }: { request: { action: string; method?: string } }) => {
      if (request.action === "describePreferencesProvider") return descriptor;
      if (request.action === "openPreferencesProvider")
        return { token: `child-${++serial}`, ...descriptor.view };
      if (request.action === "prepareCall") return `request-${serial}`;
      if (request.action === "call") return { revision: "public-revision", values: {} };
      return null;
    },
  );
  const plugin = createNativePluginViewClient(
    { windowId: "satellite", document: "document" },
    { report: vi.fn(), invoke: invoke as never, load: async () => module },
  );
  disposals.push(plugin.dispose);
  const controller = createPanelViewState(initial);
  disposals.push(controller.dispose);
  const record: WindowViewRecord = {
    key: "display",
    panelId: "settings-view:test",
    controller,
    staged,
    lease: { panelId: "settings-view:test", windowId: "satellite", generation: 3 },
  };
  useWindowViews.setState({ entries: new Map([[record.panelId, record]]) });
  usePanelWindows.setState({
    available: true,
    windowId: "satellite",
    snapshot: { windows: [], panels: [record.lease!], transfers: [] },
  });
  const client = {
    windowId: "satellite",
    pluginViews: () => plugin,
    subscribeForwardingProvider: async () => () => {},
  } as unknown as PanelWindowClient;
  const settings = createDefaultSettings();
  const services = {
    useData: () => ({ settings, busy: false, error: null }),
    isCurrent: (value: unknown) => value === settings,
    Provider: WindowPreferencesProvider,
  };
  function Fields() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>Native fields {count}</button>;
  }
  function Presentation() {
    const current = useWindowViews((s) => s.entries.get(record.panelId)) ?? record;
    return (
      <PanelViewStateScope controller={controller}>
        <SettingsProviderScope client={client} record={current}>
          <PreferenceSurfaceView
            services={services}
            section="general"
            query=""
            modifiedOnly={false}
            fields={[]}
            visible
          >
            <Fields />
          </PreferenceSurfaceView>
        </SettingsProviderScope>
      </PanelViewStateScope>
    );
  }
  const display = () => <Presentation />;
  return {
    display,
    controller,
    record,
    activate,
    createView,
    restore,
    invoke,
    context: () => observed!,
  };
}
it("uses a genuine factory, restores its draft and keeps Fields across staged promotion without singleton replay", async () => {
  const f = fixture();
  const view = render(f.display());
  const input = await screen.findByRole("textbox", { name: "Provider draft" });
  fireEvent.change(input, { target: { value: "retained-provider-draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Native fields 0" }));
  const capsule = await f.controller.captureAsync(new AbortController().signal);
  view.unmount();
  const next = fixture(capsule, true);
  const restored = render(next.display());
  expect(
    ((await screen.findByRole("textbox", { name: "Provider draft" })) as HTMLInputElement).value,
  ).toBe("retained-provider-draft");
  expect(next.restore).toHaveBeenCalledWith({ draft: "retained-provider-draft" });
  const fields = screen.getByRole("button", { name: "Native fields 0" });
  await expect(next.context().read()).resolves.toEqual({ revision: "public-revision", values: {} });
  // update() is async: staged authority is rejected, not an IPC grant.
  await expect(
    next.context().update({ revision: "public-revision", changes: {} }),
  ).rejects.toThrow();
  await act(async () => {
    useWindowViews.setState({
      entries: new Map([[next.record.panelId, { ...next.record, staged: false }]]),
    });
    restored.rerender(next.display());
  });
  expect(screen.getByRole("button", { name: "Native fields 0" })).toBe(fields);
  await expect(
    next.context().update({ revision: "public-revision", changes: {} }),
  ).resolves.toEqual({ revision: "public-revision", values: {} });
  expect(f.activate).not.toHaveBeenCalled();
  expect(next.activate).not.toHaveBeenCalled();
  expect(next.createView).toHaveBeenCalledTimes(1);
});
it("denies retained callbacks once their display owner retires", async () => {
  const f = fixture();
  render(f.display());
  await screen.findByRole("textbox", { name: "Provider draft" });
  const old = f.context();
  await act(async () => useWindowViews.setState({ entries: new Map() }));
  await expect(old.read()).rejects.toThrow("staleOwner");
  expect(f.invoke.mock.calls.filter(([, v]) => v.request.action === "call")).toHaveLength(0);
});
