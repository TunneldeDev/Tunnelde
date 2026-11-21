import "@/i18n/i18n";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { NativePluginPanel } from "@/components/layout/NativePluginPanel";
import { createWindowViews, installWindowViews, useWindowViews } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { NativePanelSnapshot, NativePluginViewDescriptor } from "@/lib/panels/windowProtocol";
import type { FrontendViewContext } from "@/lib/extensions/uiSdk";
import { usePanelWindows } from "@/store/panelWindows";
const descriptor: NativePluginViewDescriptor = {
  panelId: "plugin:sample:files",
  revision: "approved",
  pluginId: "sample",
  runtimeId: "r1",
  generation: 4,
  viewId: "files",
  entry: "index.mjs",
  sdkVersion: "0.1.0",
  title: "Sample",
  allowFloating: true,
};
const lease = { panelId: descriptor.panelId, windowId: "main", generation: 2 };
const snapshot = (
  panels: NativePanelSnapshot["panels"] = [],
  transfers: NativePanelSnapshot["transfers"] = [],
): NativePanelSnapshot => ({ windows: [], panels, transfers, pluginViews: [descriptor] });
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  usePanelWindows.setState({
    available: false,
    snapshot: { windows: [], panels: [], transfers: [] },
  });
});
function fixture(windowId = "main", restoreGate?: Promise<void>) {
  const activate = vi.fn(),
    dispose = vi.fn();
  const createView = vi.fn((context: FrontendViewContext) => {
    let draft = "seed";
    function View() {
      const [value, setValue] = useState(draft);
      return (
        <input
          aria-label="Plugin draft"
          data-panel-focus="plugin-draft"
          value={value}
          onChange={(event) => {
            draft = event.target.value;
            setValue(draft);
          }}
        />
      );
    }
    return {
      component: View,
      dispose,
      captureState: () => ({ draft }),
      restoreState: async (state: unknown) => {
        await restoreGate;
        await context.api.call("storage.get", { key: "draft" });
        draft = (state as { draft: string }).draft;
      },
    };
  });
  const open = vi.fn(async () => ({ ...descriptor, token: "exact-child" }));
  const transport = {
    load: vi.fn(async () => ({ activate, createView })),
    close: vi.fn(async () => {}),
    call: vi.fn(async () => null as never),
  };
  const client = {
    windowId,
    control: vi.fn(async () => null),
    pluginViews: vi.fn(() => ({ open, transport })),
  } as unknown as PanelWindowClient;
  const views = createWindowViews(client);
  stops.push(installWindowViews(views));
  const receive = async (next: NativePanelSnapshot) => {
    usePanelWindows.setState({ available: true, windowId, snapshot: next });
    await views.reconcile(next);
  };
  const ui = () =>
    render(
      <NativePanelView panelId={descriptor.panelId}>
        <NativePluginPanel panelId={descriptor.panelId} />
      </NativePanelView>,
    );
  return { views, receive, ui, open, activate, createView, dispose, transport };
}
it("mounts the main source through the scoped native factory and captures its actual edited draft", async () => {
  const f = fixture();
  await f.receive(snapshot([lease]));
  const ui = f.ui();
  const input = await screen.findByRole("textbox");
  expect(f.open).toHaveBeenCalledExactlyOnceWith({ kind: "owned", lease }, "sample", "r1", "files");
  expect(f.activate).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "unsaved private draft" } });
  const capsule = await f.views.captureAsync(descriptor.panelId);
  expect(capsule.view.fields["plugin.factory"]).toEqual({
    version: 1,
    pluginId: "sample",
    viewId: "files",
    state: { draft: "unsaved private draft" },
  });
  ui.unmount();
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledExactlyOnceWith("exact-child"));
  expect(f.dispose).toHaveBeenCalledOnce();
});
it("waits for real staged restoration and promotes the same component, DOM node and attachment without reactivation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture("target", gate);
  const offer = { id: "incoming", lease, targetWindow: "target" };
  await f.receive(snapshot([], [{ offer, ready: false }]));
  const state = {
    version: 1,
    view: {
      version: 1,
      fields: {
        "plugin.factory": {
          version: 1,
          pluginId: "sample",
          viewId: "files",
          state: { draft: "restored private draft" },
        },
      },
    },
    dom: { version: 1, scroll: {}, focus: null },
  };
  const staged = f.views.stage(offer, state, new AbortController().signal);
  let ready = false;
  void staged.then(() => {
    ready = true;
  });
  f.ui();
  await vi.waitFor(() => expect(f.createView).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  expect(screen.queryByRole("textbox")).toBeNull();
  await act(async () => {
    release();
  });
  const input = await screen.findByRole("textbox");
  await staged;
  expect(input).toHaveProperty("value", "restored private draft");
  expect(f.transport.call).toHaveBeenCalledWith(
    "exact-child",
    "storage.get",
    { key: "draft" },
    expect.any(AbortSignal),
  );
  const controller = useWindowViews.getState().entries.get(descriptor.panelId)!.controller;
  await act(async () => {
    await f.receive(snapshot([{ ...lease, windowId: "target", generation: 3 }]));
  });
  expect(screen.getByRole("textbox")).toBe(input);
  expect(f.open).toHaveBeenCalledExactlyOnceWith(
    { kind: "staged", id: "incoming" },
    "sample",
    "r1",
    "files",
  );
  expect(f.createView).toHaveBeenCalledOnce();
  expect(f.activate).not.toHaveBeenCalled();
  expect(useWindowViews.getState().entries.get(descriptor.panelId)!.controller).toBe(controller);
  expect(f.transport.close).not.toHaveBeenCalled();
});
it("retirement aborts the pending scoped factory and cannot acknowledge a late restored tree", async () => {
  let release!: () => void;
  const f = fixture(
    "target",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const offer = { id: "retired", lease, targetWindow: "target" };
  await f.receive(snapshot([], [{ offer, ready: false }]));
  const staged = f.views.stage(
    offer,
    {
      version: 1,
      view: {
        version: 1,
        fields: {
          "plugin.factory": {
            version: 1,
            pluginId: "sample",
            viewId: "files",
            state: { draft: "old draft" },
          },
        },
      },
      dom: { version: 1, scroll: {}, focus: null },
    },
    new AbortController().signal,
  );
  const rejected = expect(staged).rejects.toThrow("cancelled");
  f.ui();
  await vi.waitFor(() => expect(f.createView).toHaveBeenCalledOnce());
  await act(async () => {
    await f.receive({ windows: [], panels: [], transfers: [], pluginViews: [] });
    release();
  });
  await rejected;
  expect(screen.queryByRole("textbox")).toBeNull();
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledExactlyOnceWith("exact-child"));
});
