import "@/i18n/i18n";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ForwardingHostSection } from "@/features/forwarding/ForwardingSection";
import { ForwardingSurface } from "@/features/forwarding/components/ForwardingSurface";
import { WindowForwardingSection } from "@/features/forwarding/components/WindowForwardingSection";
import { ForwardingReadScope } from "@/features/forwarding/data/readScope";
import type { ForwardingReadData } from "@/features/forwarding/data/readModel";
import type { WindowForwardingViewOwner } from "@/features/forwarding/runtime/windowProviderSource";
import {
  createFrontendRuntime,
  frontendRuntime,
  type FrontendSession,
  type FrontendTransport,
} from "@/lib/extensions/frontendRuntime";
import type { FrontendContext, FrontendModule, FrontendViewProps } from "@/lib/extensions/uiSdk";
import type { PluginInfo } from "@/lib/api/types";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { createNativePluginViewClient } from "@/lib/panels/windowPluginClient";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { PanelStateLossRequired } from "@/lib/panels/stateLoss";
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
  id: "stateful-forwarding",
  name: "Stateful forwarding",
  version: "1.0.0",
  apiVersion: 2,
  description: null,
  error: null,
  path: "/plugins/stateful-forwarding",
  fingerprint: "approved",
  runtimeId: "boot:1",
  status: "running",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [],
  permissions: ["ui.trusted", "hosts.read", "forwards.read", "forwards.write"],
  views: [{ id: "forwards", title: "Forwarding", kind: "component", provider: "forwarding" }],
};
const host = {
  id: "host",
  name: "Server",
  host: "example",
  port: 22,
  username: "qa",
  authMethod: "password",
} as const;
const data: ForwardingReadData = {
  hosts: [host],
  hostsLoading: false,
  sessions: [],
  rules: { entries: [], busy: false, error: null },
  groups: { entries: [], busy: false, error: null },
};
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(legacy = false) {
  const capture = vi.fn(),
    restore = vi.fn(),
    instanceDisposed = vi.fn();
  const createView = vi.fn(() => {
    let draft = "seed";
    return {
      component: function Provider({ forwarding }: FrontendViewProps) {
        const [text, setText] = useState(draft);
        const Entries = forwarding!.Entries;
        return (
          <>
            <input
              aria-label="Provider draft"
              value={text}
              onChange={(event) => {
                draft = event.target.value;
                setText(draft);
              }}
            />
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
      dispose: instanceDisposed,
    };
  });
  function Registered({ forwarding }: FrontendViewProps) {
    const [text, setText] = useState("legacy seed");
    const Entries = forwarding!.Entries;
    return (
      <>
        <input aria-label="Legacy draft" value={text} onChange={(e) => setText(e.target.value)} />
        <Entries />
      </>
    );
  }
  const activate = vi.fn((ctx: FrontendContext) => {
    if (legacy) ctx.views.register("forwards", Registered);
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
      uiProviders: {
        forwarding: { pluginId: plugin.id, viewId: "forwards" },
      },
    },
  });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: {
      ...state.state,
      restricted: false,
      grants: { [plugin.id]: plugin.permissions },
    },
  }));
  const descriptor = {
    selectionRevision: 5,
    capabilities: { write: true },
    view: {
      pluginId: plugin.id,
      runtimeId: session.runtimeId,
      generation: session.generation,
      viewId: "forwards",
      entry: session.entry,
      sdkVersion: session.sdkVersion,
      title: "Forwarding",
      allowFloating: true,
    },
  };
  const invoke = vi.fn(async (_command: string, { request }: { request: { action: string } }) => {
    if (request.action === "describeForwardingProvider") return descriptor;
    if (request.action === "openForwardingProvider")
      return { ...session, token: `native-child-${++serial}` };
    return null;
  });
  const nativeClient = createNativePluginViewClient(
    { windowId: "satellite", document: "document" },
    {
      invoke: invoke as never,
      load: async () => module,
      report: vi.fn(),
    },
  );
  const client = {
    windowId: "satellite",
    pluginViews: () => nativeClient,
    subscribeForwardingProvider: async () => () => {},
  } as unknown as PanelWindowClient;
  const owner: WindowForwardingViewOwner = {
    client,
    target: () => ({ kind: "staged", id: "offer" }),
    check() {},
  };
  const state = (initial?: unknown) => {
    const controller = createPanelViewState(initial);
    disposals.push(controller.dispose);
    return controller;
  };
  const tree = (controller: ReturnType<typeof state>, native = false) => (
    <PanelViewStateScope controller={controller}>
      <ForwardingReadScope value={data}>
        {native ? (
          <WindowForwardingSection host={host} client={client} owner={owner} />
        ) : (
          <ForwardingHostSection
            host={host}
            renderSurface={(props) => <ForwardingSurface {...props} />}
            renderConnection={() => null}
          />
        )}
      </ForwardingReadScope>
    </PanelViewStateScope>
  );
  disposals.push(() => {
    nativeClient.dispose();
    runtime.dispose();
  });
  return {
    state,
    tree,
    activate,
    createView,
    capture,
    restore,
    transport,
    runtime,
    invoke,
    instanceDisposed,
    module,
  };
}

it("preserves a real main provider factory draft through native staging and back without reactivating the singleton", async () => {
  const f = fixture();
  const module = deferred<FrontendModule>();
  const actual = await f.transport.load({} as FrontendSession);
  vi.mocked(f.transport.load).mockReturnValue(module.promise);
  const source = f.state();
  const main = render(f.tree(source));
  let admitted = false;
  const waiting = source.waitReady(new AbortController().signal).then(() => {
    admitted = true;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  expect(f.createView).not.toHaveBeenCalled();
  await act(async () => {
    module.resolve(actual);
  });
  await screen.findByLabelText("Provider draft");
  await waiting;
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "unsaved main draft" },
  });
  const capsule = await source.captureAsync();
  expect(JSON.stringify(capsule)).toContain("unsaved main draft");
  expect(JSON.stringify(capsule)).not.toMatch(
    /singleton-activation|main-child-|native-child-|document/,
  );
  main.unmount();
  const target = f.state(capsule);
  const native = render(f.tree(target, true));
  const staged = target.waitReady(new AbortController().signal);
  await screen.findByLabelText("Provider draft");
  await staged;
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "unsaved main draft");
  const stagedCapture = await target.captureAsync();
  expect(stagedCapture.fields).toEqual({ ...capsule.fields, "native-confirmation": null });
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "satellite draft" },
  });
  const returned = await target.captureAsync();
  native.unmount();
  const back = f.state(returned);
  render(f.tree(back));
  const ready = back.waitReady(new AbortController().signal);
  await screen.findByLabelText("Provider draft");
  await ready;
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "satellite draft");
  expect((await back.captureAsync()).fields).toEqual({
    "forwarding-host": returned.fields["forwarding-host"],
  });
  expect(f.restore.mock.calls).toEqual([
    [{ draft: "unsaved main draft" }],
    [{ draft: "satellite draft" }],
  ]);
  expect(f.activate).toHaveBeenCalledOnce();
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.transport.openView).toHaveBeenCalledTimes(2);
  expect(
    f.invoke.mock.calls.filter(([, { request }]) => request.action === "openForwardingProvider"),
  ).toHaveLength(1);
});

it("does not acknowledge the main factory shell before the original child attachment and renderer commit", async () => {
  const f = fixture();
  const child = deferred<FrontendSession>();
  const session = await f.transport.openView!("singleton-activation", "forwards", "fixture");
  vi.mocked(f.transport.openView!).mockClear().mockReturnValue(child.promise);
  const source = f.state();
  render(f.tree(source));
  let admitted = false;
  const ready = source.waitReady(new AbortController().signal).then(() => {
    admitted = true;
  });
  await waitFor(() => expect(f.transport.openView).toHaveBeenCalledOnce());
  expect(admitted).toBe(false);
  expect(f.createView).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Provider draft")).toBeNull();
  await act(async () => {
    child.resolve(session);
  });
  await screen.findByLabelText("Provider draft");
  await ready;
  expect(admitted).toBe(true);
  expect(f.activate).toHaveBeenCalledOnce();
});

it("rejects main admission and capture after a factory failure even when builtin recovery rows are visible", async () => {
  const f = fixture(),
    source = f.state();
  f.createView.mockImplementation(() => {
    throw new Error("main factory failed");
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(f.tree(source));
    const rejected = expect(source.waitReady(new AbortController().signal)).rejects.toThrow();
    await screen.findByRole("alert");
    await rejected;
    expect(screen.getByText("No forwarding rules yet")).toBeTruthy();
    await expect(source.waitReady(new AbortController().signal)).rejects.toThrow(
      "main factory failed",
    );
    await expect(source.captureAsync()).rejects.toThrow("main factory failed");
    expect(f.activate).toHaveBeenCalledOnce();
  } finally {
    errors.mockRestore();
  }
});

it("never reactivates a no-createView legacy module in the destination or discards the still-mounted source draft", async () => {
  const f = fixture(true),
    source = f.state();
  delete f.module.createView;
  render(f.tree(source));
  await screen.findByLabelText("Legacy draft");
  await source.waitReady(new AbortController().signal);
  fireEvent.change(screen.getByLabelText("Legacy draft"), {
    target: { value: "keep source draft" },
  });
  const error = await source.captureAsync().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PanelStateLossRequired);
  const capsule = await source.captureAsync(undefined, {
    consentedStateLoss: new Set((error as PanelStateLossRequired).views),
  });
  const target = f.state(capsule);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const staged = render(f.tree(target, true));
    const rejected = expect(target.waitReady(new AbortController().signal)).rejects.toThrow();
    await screen.findByRole("alert");
    await rejected;
    expect(screen.queryByLabelText("Provider draft")).toBeNull();
    expect(screen.getByLabelText("Legacy draft")).toHaveProperty("value", "keep source draft");
    expect(f.createView).not.toHaveBeenCalled();
    expect(f.activate).toHaveBeenCalledOnce();
    staged.unmount();
    expect(screen.getByLabelText("Legacy draft")).toHaveProperty("value", "keep source draft");
  } finally {
    errors.mockRestore();
  }
});

it.each(["main", "native"])(
  "rejects a captured provider replaced by builtin selection before %s destination mount",
  async (destination) => {
    const f = fixture(),
      source = f.state();
    const main = render(f.tree(source));
    await screen.findByLabelText("Provider draft");
    await source.waitReady(new AbortController().signal);
    fireEvent.change(screen.getByLabelText("Provider draft"), {
      target: { value: "must not silently disappear" },
    });
    const capsule = await source.captureAsync();
    main.unmount();
    if (destination === "main") {
      useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } }));
    } else {
      f.invoke.mockImplementation(async () => null);
    }
    const target = f.state(capsule);
    render(f.tree(target, destination === "native"));
    await screen.findByText("No forwarding rules yet");
    await expect(target.waitReady(new AbortController().signal)).rejects.toThrow(
      "viewStateUnavailable",
    );
    await expect(target.captureAsync()).rejects.toThrow("viewStateUnavailable");
    expect(f.createView).toHaveBeenCalledOnce();
  },
);

it("allows an explicit user deselection after the matching main provider draft has restored", async () => {
  const f = fixture(),
    source = f.state();
  const first = render(f.tree(source));
  await screen.findByLabelText("Provider draft");
  await source.waitReady(new AbortController().signal);
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "restored first" },
  });
  const capsule = await source.captureAsync();
  first.unmount();
  const restored = f.state(capsule);
  render(f.tree(restored));
  await screen.findByLabelText("Provider draft");
  await restored.waitReady(new AbortController().signal);
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "restored first");
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } })),
  );
  expect(screen.getByText("No forwarding rules yet")).toBeTruthy();
  expect(screen.queryByLabelText("Provider draft")).toBeNull();
  await restored.waitReady(new AbortController().signal);
  expect(JSON.stringify(await restored.captureAsync())).not.toContain("restored first");
  expect(f.activate).toHaveBeenCalledOnce();
});

it("keeps the restore obligation when a matching main shell is deselected before its child opens", async () => {
  const f = fixture(),
    source = f.state();
  const first = render(f.tree(source));
  await screen.findByLabelText("Provider draft");
  await source.waitReady(new AbortController().signal);
  const capsule = await source.captureAsync();
  first.unmount();
  const session = await f.transport.openView!("singleton-activation", "forwards", "fixture");
  const child = deferred<FrontendSession>();
  vi.mocked(f.transport.openView!).mockClear().mockReturnValue(child.promise);
  const target = f.state(capsule);
  render(f.tree(target));
  const originalWait = expect(target.waitReady(new AbortController().signal)).rejects.toThrow();
  await waitFor(() => expect(f.transport.openView).toHaveBeenCalledOnce());
  expect(screen.queryByLabelText("Provider draft")).toBeNull();
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } })),
  );
  await originalWait;
  await expect(target.waitReady(new AbortController().signal)).rejects.toThrow(
    "viewStateUnavailable",
  );
  await act(async () => {
    child.resolve(session);
  });
  expect(screen.queryByLabelText("Provider draft")).toBeNull();
  await expect(target.captureAsync()).rejects.toThrow("viewStateUnavailable");
  expect(f.createView).toHaveBeenCalledOnce();
});

it("keeps registered renderers intact and requires exact source-instance consent before a factory reset", async () => {
  const f = fixture(true),
    source = f.state();
  const main = render(f.tree(source));
  await screen.findByLabelText("Legacy draft");
  await source.waitReady(new AbortController().signal);
  fireEvent.change(screen.getByLabelText("Legacy draft"), {
    target: { value: "untransferable legacy draft" },
  });
  expect(f.createView).not.toHaveBeenCalled();
  const error = await source.captureAsync().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PanelStateLossRequired);
  const loss = (error as PanelStateLossRequired).views;
  await expect(
    source.captureAsync(undefined, {
      consentedStateLoss: new Set(loss.map((entry) => ({ ...entry }))),
    }),
  ).rejects.toBeInstanceOf(PanelStateLossRequired);
  const capsule = await source.captureAsync(undefined, { consentedStateLoss: new Set(loss) });
  expect(JSON.stringify(capsule)).toContain('"reset":true');
  expect(JSON.stringify(capsule)).not.toContain("untransferable legacy draft");
  expect(screen.getByLabelText("Legacy draft")).toHaveProperty(
    "value",
    "untransferable legacy draft",
  );
  main.unmount();
  const target = f.state(capsule);
  render(f.tree(target, true));
  const ready = target.waitReady(new AbortController().signal);
  await screen.findByLabelText("Provider draft");
  await ready;
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "seed");
  expect(f.restore).not.toHaveBeenCalled();
  expect(f.createView).toHaveBeenCalledOnce();
  expect(f.activate).toHaveBeenCalledOnce();
});
