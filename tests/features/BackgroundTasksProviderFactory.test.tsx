import "@/i18n/i18n";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundTasksSurface } from "@/features/tasks/components/BackgroundTasksSurface";
import {
  createFrontendRuntime,
  frontendRuntime,
  type FrontendSession,
  type FrontendTransport,
} from "@/lib/extensions/frontendRuntime";
import type { FrontendContext, FrontendModule, FrontendViewProps } from "@/lib/extensions/uiSdk";
import type { PluginInfo } from "@/lib/api/types";
import {
  createPanelViewState,
  PanelViewStateScope,
  PanelViewStateGroup,
} from "@/lib/panels/viewState";
import {
  createNativePluginViewClient,
  type NativePluginViewTarget,
} from "@/lib/panels/windowPluginClient";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { TaskModelScope, type TaskPanelModel } from "@/lib/panels/taskModel";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";
import { registerBackgroundTaskSource, useBackgroundTasks } from "@/lib/tasks/registry";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (token: string) => `https://native/${token}`,
}));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
const plugin: PluginInfo = {
  id: "stateful-tasks",
  name: "Task provider",
  version: "1.0.0",
  apiVersion: 2,
  description: null,
  error: null,
  path: "/plugins/stateful-tasks",
  fingerprint: "approved",
  runtimeId: "boot:1",
  status: "running",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [],
  permissions: ["ui.trusted", "backgroundTasks.read", "backgroundTasks.write"],
  views: [{ id: "tasks", title: "Tasks", kind: "component", provider: "backgroundTasks" }],
};
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
function fixture() {
  const run = vi.fn();
  disposals.push(
    registerBackgroundTaskSource({
      id: "qa-tasks",
      snapshot: () => [
        {
          id: "task",
          title: "Real task",
          status: "running",
          updatedAt: 1,
          execution: "native",
          actions: [{ id: "pause", label: "Pause", run }],
        },
      ],
      subscribe: () => () => {},
    }),
  );
  const entries = useBackgroundTasks.getState().items;
  const activate = vi.fn((_ctx: FrontendContext) => {});
  let observed: FrontendViewProps["backgroundTasks"];
  const restore = vi.fn(),
    capture = vi.fn(),
    disposed = vi.fn();
  const createView = vi.fn(() => {
    let draft = "seed";
    return {
      component: function Provider({ backgroundTasks }: FrontendViewProps) {
        const [text, setText] = useState(draft),
          [error, setError] = useState("");
        observed = backgroundTasks;
        const row = backgroundTasks!.read({ revision: backgroundTasks!.snapshot.revision })
          .items[0]!;
        const Entries = backgroundTasks!.Entries;
        return (
          <>
            <input
              aria-label="Provider draft"
              value={text}
              onChange={(e) => {
                draft = e.target.value;
                setText(draft);
              }}
            />
            <span>Projected {row.title}</span>
            <span>{backgroundTasks!.capabilities.actions ? "Writable" : "Read only"}</span>
            <button
              onClick={() =>
                void backgroundTasks!
                  .runAction({
                    revision: backgroundTasks!.snapshot.revision,
                    key: row.key,
                    actionId: "pause",
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Provider pause
            </button>
            <span role="status">{error}</span>
            <Entries />
          </>
        );
      },
      captureState() {
        capture();
        return { draft };
      },
      restoreState(state: unknown) {
        restore(state);
        draft = (state as { draft: string }).draft;
      },
      dispose: disposed,
    };
  });
  const module: FrontendModule = { activate, createView };
  const session: FrontendSession = {
    token: "singleton-activation",
    pluginId: plugin.id,
    runtimeId: plugin.runtimeId!,
    generation: 3,
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  };
  let serial = 0;
  const transport: FrontendTransport = {
    current: () => true,
    open: vi.fn(async () => session),
    openView: vi.fn(async () => ({ ...session, token: `main-child-${++serial}` })),
    close: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    call: vi.fn(async () => undefined as never),
    load: vi.fn(async () => module),
    report: vi.fn(),
  };
  const runtime = createFrontendRuntime(transport);
  for (const key of [
    "view",
    "ensure",
    "token",
    "subscribe",
    "revision",
    "viewScope",
    "isFactoryView",
  ] as const)
    vi.spyOn(frontendRuntime, key).mockImplementation(runtime[key] as never);
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      uiProviders: { backgroundTasks: { pluginId: plugin.id, viewId: "tasks" } },
    },
  });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((s) => ({
    state: { ...s.state, restricted: false, grants: { [plugin.id]: plugin.permissions } },
  }));
  let descriptor: {
    selectionRevision: number;
    capabilities: { write: boolean };
    view: {
      pluginId: string;
      runtimeId: string;
      generation: number;
      viewId: string;
      entry: string;
      sdkVersion: string;
      title: string;
      allowFloating: boolean;
    };
  } | null = {
    selectionRevision: 4,
    capabilities: { write: true },
    view: {
      pluginId: plugin.id,
      runtimeId: session.runtimeId,
      generation: 3,
      viewId: "tasks",
      entry: session.entry,
      sdkVersion: session.sdkVersion,
      title: "Tasks",
      allowFloating: true,
    },
  };
  const invoke = vi.fn(async (_command: string, { request }: { request: { action: string } }) => {
    if (request.action === "describeTasksProvider") return descriptor;
    if (request.action === "openTasksProvider")
      return { ...session, token: `native-child-${++serial}` };
    if (request.action === "submitTasksProviderAction") return "host-action-receipt";
    return null;
  });
  const native = createNativePluginViewClient(
    { windowId: "satellite", document: "native-document" },
    { invoke: invoke as never, load: async () => module, report: vi.fn() },
  );
  let invalidated: (() => void) | undefined;
  const receiveAction = vi.fn(async () => {
    run();
    return null;
  });
  const client = {
    windowId: "satellite",
    pluginViews: () => native,
    receiveAction,
    subscribeForwardingProvider: async (changed: () => void) => {
      invalidated = changed;
      return () => {};
    },
  } as unknown as PanelWindowClient;
  let target: NativePluginViewTarget = { kind: "staged", id: "offer" };
  const owner: WindowProviderOwner = {
    client,
    target: () => target,
    check(mutation) {
      if (mutation && target.kind !== "owned") throw new Error("panel.window.staleOwner");
    },
  };
  const state = (initial?: unknown) => {
    const c = createPanelViewState(initial);
    disposals.push(c.dispose);
    return c;
  };
  const model: TaskPanelModel = {
    providerOwner: owner,
    items: entries,
    viewKey: () => "private-incarnation-ticket",
    run: async () => {
      throw new Error("must not use builtin task actions for provider");
    },
    clear: async () => ({ count: 0 }),
  };
  const tree = (controller: ReturnType<typeof state>, remote = false, visible = true) => {
    const surface = (
      <BackgroundTasksSurface entries={entries} embedded visible={visible}>
        <div>Native task rows</div>
      </BackgroundTasksSurface>
    );
    return (
      <PanelViewStateScope controller={controller}>
        <PanelViewStateGroup name="tasks.rows">
          {remote ? <TaskModelScope value={model}>{surface}</TaskModelScope> : surface}
        </PanelViewStateGroup>
      </PanelViewStateScope>
    );
  };
  disposals.push(() => {
    native.dispose();
    runtime.dispose();
  });
  return {
    state,
    tree,
    activate,
    createView,
    restore,
    capture,
    transport,
    invoke,
    receiveAction,
    run,
    promote() {
      target = { kind: "owned", lease: { panelId: "tasks", windowId: "satellite", generation: 2 } };
      invalidated?.();
    },
    deselect() {
      descriptor = null;
      invalidated?.();
    },
    observed: () => observed!,
    readonly() {
      descriptor!.capabilities.write = false;
      invalidated?.();
    },
  };
}
it("restores task provider drafts main → staged native → main, without replaying singleton activation", async () => {
  const f = fixture();
  const source = f.state();
  const main = render(f.tree(source));
  await screen.findByLabelText("Provider draft");
  await source.waitReady(new AbortController().signal);
  expect(screen.getAllByText("Native task rows")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Provider draft"), { target: { value: "main draft" } });
  const capsule = await source.captureAsync();
  main.unmount();
  const destination = f.state(capsule);
  const satellite = render(f.tree(destination, true));
  await screen.findByLabelText("Provider draft");
  await destination.waitReady(new AbortController().signal);
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "main draft");
  expect(screen.getByText("Projected Real task")).toBeTruthy();
  fireEvent.click(screen.getByText("Provider pause"));
  await screen.findByText("panel.window.staleOwner");
  expect(f.run).not.toHaveBeenCalled();
  act(() => f.promote());
  fireEvent.click(screen.getByText("Provider pause"));
  await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  expect(f.invoke).toHaveBeenCalledWith(
    "panel_window_plugin_view",
    expect.objectContaining({
      request: {
        action: "submitTasksProviderAction",
        token: expect.stringMatching(/^native-child-/),
        lease: { panelId: "tasks", windowId: "satellite", generation: 2 },
        key: expect.any(String),
        ticket: "private-incarnation-ticket",
        actionId: "pause",
      },
    }),
  );
  expect(f.receiveAction).toHaveBeenCalledWith("host-action-receipt", expect.any(AbortSignal));
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "satellite draft" },
  });
  const returning = await destination.captureAsync();
  expect(JSON.stringify(returning)).not.toMatch(
    /singleton-activation|main-child-|native-child-|private-incarnation-ticket|native-document/,
  );
  satellite.unmount();
  const back = f.state(returning);
  render(f.tree(back));
  await screen.findByLabelText("Provider draft");
  await back.waitReady(new AbortController().signal);
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "satellite draft");
  expect(f.activate).toHaveBeenCalledOnce();
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.restore.mock.calls).toEqual([[{ draft: "main draft" }], [{ draft: "satellite draft" }]]);
});
it("does not silently replace a captured task provider with builtin rows when selection disappears", async () => {
  const f = fixture();
  const source = f.state();
  const main = render(f.tree(source));
  await screen.findByLabelText("Provider draft");
  const capsule = await source.captureAsync();
  main.unmount();
  f.deselect();
  const target = f.state(capsule);
  render(f.tree(target, true));
  await screen.findByText("Native task rows");
  await expect(target.captureAsync()).rejects.toThrow();
  expect(f.createView).toHaveBeenCalledOnce();
});
it("native read-only capability keeps task listing and builtin entries, but rejects provider mutations", async () => {
  const f = fixture();
  f.promote();
  f.readonly();
  const controller = f.state();
  render(f.tree(controller, true));
  await screen.findByText("Read only");
  await controller.waitReady(new AbortController().signal);
  fireEvent.click(screen.getByText("Provider pause"));
  await screen.findByText("plugin.permission:backgroundTasks.write");
  expect(f.run).not.toHaveBeenCalled();
  expect(f.receiveAction).not.toHaveBeenCalled();
  expect(screen.getByText("Native task rows")).toBeTruthy();
});

it("retires provider action frames when their retained task surface becomes hidden", async () => {
  for (const remote of [false, true]) {
    const f = fixture();
    f.promote();
    const controller = f.state();
    const ui = render(f.tree(controller, remote));
    await screen.findByLabelText("Provider draft");
    await controller.waitReady(new AbortController().signal);
    const frame = f.observed();
    const row = frame.read({ revision: frame.snapshot.revision }).items[0]!;
    ui.rerender(f.tree(controller, remote, false));
    await expect(
      frame.runAction({ revision: frame.snapshot.revision, key: row.key, actionId: "pause" }),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    ui.unmount();
    // Dispose each source before registering the next fixture in this test.
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  }
});
