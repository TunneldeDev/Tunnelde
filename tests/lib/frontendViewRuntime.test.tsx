import { expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import { createFrontendRuntime, type FrontendTransport } from "@/lib/extensions/frontendRuntime";
import type {
  FrontendContext,
  FrontendModule,
  FrontendViewContext,
  FrontendViewInstance,
} from "@/lib/extensions/uiSdk";

const plugin = {
  id: "custom",
  fingerprint: "approved",
  runtimeId: "boot:1",
  status: "running",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [],
  permissions: ["ui.trusted"],
  views: [{ id: "main", title: "Custom", kind: "component" }],
} as unknown as PluginInfo;
const Component = () => null;
function fixture(factory?: FrontendModule["createView"]) {
  let context!: FrontendContext;
  const activate = vi.fn((value: FrontendContext) => {
    context = value;
  });
  const session = {
    token: "activation",
    pluginId: "custom",
    generation: 1,
    runtimeId: "boot:1",
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  };
  const transport: FrontendTransport = {
    current: vi.fn(() => true),
    open: vi.fn(async () => session),
    openView: vi.fn(async () => ({ ...session, token: crypto.randomUUID() })),
    close: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    call: vi.fn(async () => undefined as never),
    load: vi.fn(async () => ({ activate, createView: factory })),
    report: vi.fn(),
  };
  const runtime = createFrontendRuntime(transport);
  return { transport, runtime, activate, context: () => context };
}

it("mounts independent view factories without singleton activation, commands or background runners", async () => {
  const contexts: FrontendViewContext[] = [];
  const cleanup = vi.fn();
  const f = fixture((context) => {
    contexts.push(context);
    return { component: Component, dispose: cleanup };
  });
  await f.runtime.ensure(plugin);
  const first = (await f.runtime.mountView("custom", "main", "activation"))!;
  const second = (await f.runtime.mountView("custom", "main", "activation"))!;
  expect(f.activate).toHaveBeenCalledOnce();
  expect(f.transport.ready).toHaveBeenCalledOnce();
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.transport.openView).toHaveBeenCalledTimes(2);
  expect(contexts[0]!.signal).not.toBe(contexts[1]!.signal);
  expect(contexts[0]).not.toHaveProperty("backgroundTasks");
  expect(contexts[0]).not.toHaveProperty("commands");
  expect(contexts[0]).not.toHaveProperty("views");
  expect(Object.isFrozen(contexts[0])).toBe(true);
  expect(first.component).toBe(Component);
  await contexts[0]!.api.call("hosts.list", { limit: 1 });
  const viewToken = vi.mocked(f.transport.openView!).mock.results[0]!.value;
  expect(f.transport.call).toHaveBeenCalledWith(
    (await viewToken).token,
    "hosts.list",
    { limit: 1 },
    expect.any(AbortSignal),
  );
  first.dispose();
  expect(contexts[0]!.signal.aborted).toBe(true);
  expect(contexts[1]!.signal.aborted).toBe(false);
  expect(f.context().signal.aborted).toBe(false);
  expect(cleanup).toHaveBeenCalledOnce();
  f.runtime.stop("custom");
  expect(contexts[1]!.signal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(2);
  second.dispose();
  await vi.waitFor(() => expect(f.context().resources.size).toBe(0));
  expect(f.transport.close).toHaveBeenCalledTimes(3);
});

it("does not start or open engines for unknown, stale or undeclared view owners", async () => {
  const f = fixture(() => ({ component: Component }));
  await expect(f.runtime.mountView("custom", "main", "activation")).rejects.toThrow("closed");
  expect(f.transport.open).not.toHaveBeenCalled();
  await f.runtime.ensure(plugin);
  for (const [id, viewId, token] of [
    ["other", "main", "activation"],
    ["custom", "other", "activation"],
    ["custom", "main", "stale"],
  ])
    await expect(f.runtime.mountView(id!, viewId!, token!)).rejects.toThrow("closed");
  vi.mocked(f.transport.current).mockReturnValue(false);
  await expect(f.runtime.mountView("custom", "main", "activation")).rejects.toThrow("closed");
  expect(f.transport.openView).not.toHaveBeenCalled();
  f.runtime.dispose();
});

it("leaves legacy modules document-local instead of reactivating them as a fake view", async () => {
  const f = fixture();
  await f.runtime.ensure(plugin);
  expect(await f.runtime.mountView("custom", "main", "activation")).toBeNull();
  expect(f.transport.openView).not.toHaveBeenCalled();
  expect(f.activate).toHaveBeenCalledOnce();
  f.runtime.dispose();
});

it("clones validated ephemeral capture/restore state and preserves method receivers", async () => {
  const original = { query: "work", nested: ["one"] };
  const restored = { query: "previous", nested: ["saved"] };
  const factory = vi.fn(() => ({
    component: Component,
    value: original,
    captureState() {
      return this.value;
    },
    restoreState(state: unknown) {
      this.value = state as typeof original;
    },
  }));
  const f = fixture(factory);
  await f.runtime.ensure(plugin);
  const view = (await f.runtime.mountView("custom", "main", "activation", { value: restored }))!;
  expect(view.stateful).toBe(true);
  const captured = (await view.captureState()) as typeof original;
  expect(captured).toEqual(restored);
  expect(captured).not.toBe(restored);
  captured.nested.push("edited");
  restored.nested.push("outside");
  expect(await view.captureState()).toEqual({ query: "previous", nested: ["saved"] });
  f.runtime.dispose();
});

it("rejects invalid restore before allocating and rejects partial capture/restore support without failing the engine", async () => {
  const f = fixture(() => ({ component: Component, captureState: () => null }));
  await f.runtime.ensure(plugin);
  await expect(
    f.runtime.mountView("custom", "main", "activation", { value: { handler: () => {} } }),
  ).rejects.toThrow("panel.viewState.invalid");
  expect(f.transport.openView).not.toHaveBeenCalled();
  await expect(f.runtime.mountView("custom", "main", "activation")).rejects.toThrow(
    "invalidViewFactory",
  );
  expect(f.transport.fail).not.toHaveBeenCalled();
  expect(f.transport.close).toHaveBeenCalledOnce();
  expect(f.runtime.token("custom")).toBe("activation");
  f.runtime.dispose();
});

it.each([
  { runtimeId: "old" },
  { generation: 2 },
  { pluginId: "other" },
  { sdkVersion: "2" },
  { entry: "changed.mjs" },
  { token: "activation" },
])("rejects mismatched view session %j before loading code", async (override) => {
  const f = fixture(() => ({ component: Component }));
  await f.runtime.ensure(plugin);
  const original = await f.transport.open("custom", "boot:1");
  vi.mocked(f.transport.openView!).mockResolvedValueOnce({
    ...original,
    token: "child",
    ...override,
  });
  await expect(f.runtime.mountView("custom", "main", "activation")).rejects.toThrow("closed");
  expect(f.transport.load).toHaveBeenCalledOnce(); // singleton only
  expect(f.transport.fail).not.toHaveBeenCalled();
  f.runtime.dispose();
});

it("cleans a native view session which arrives after the parent has retired", async () => {
  const f = fixture(() => ({ component: Component }));
  await f.runtime.ensure(plugin);
  let finish!: (value: Awaited<ReturnType<FrontendTransport["open"]>>) => void;
  vi.mocked(f.transport.openView!).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.runtime.mountView("custom", "main", "activation");
  const check = expect(pending).rejects.toThrow("closed");
  f.runtime.stop("custom");
  await check;
  finish({
    token: "late",
    pluginId: "custom",
    runtimeId: "boot:1",
    generation: 1,
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  });
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledWith("late"));
  expect(f.transport.load).toHaveBeenCalledOnce();
  expect(f.transport.fail).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.context().resources.size).toBe(0));
});

it("cleans a late factory result and never fails the singleton when view setup is cancelled", async () => {
  let finish!: (value: FrontendViewInstance) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.runtime.ensure(plugin);
  const pending = f.runtime.mountView("custom", "main", "activation");
  const check = expect(pending).rejects.toThrow("closed");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.runtime.stop("custom");
  await check;
  const dispose = vi.fn();
  finish({ component: Component, dispose });
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(f.transport.fail).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.context().resources.size).toBe(0));
});

it("aborts only the disposed view's calls and rejects stale capture replies", async () => {
  let context!: FrontendViewContext;
  let capture!: (value: unknown) => void;
  const f = fixture((value) => {
    context = value;
    return {
      component: Component,
      captureState: () =>
        new Promise((resolve) => {
          capture = resolve;
        }),
      restoreState: () => {},
    };
  });
  await f.runtime.ensure(plugin);
  const view = (await f.runtime.mountView("custom", "main", "activation"))!;
  const received: AbortSignal[] = [];
  vi.mocked(f.transport.call).mockImplementation((_token, _method, _params, signal) => {
    received.push(signal!);
    return new Promise((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  const call = context.api.call("hosts.list");
  const callCheck = expect(call).rejects.toThrow("closed");
  const snapshot = view.captureState();
  const snapshotCheck = expect(snapshot).rejects.toThrow("closed");
  view.dispose();
  await callCheck;
  await snapshotCheck;
  expect(received[0]!.aborted).toBe(true);
  capture({ late: true });
  expect(f.context().signal.aborted).toBe(false);
  expect(() => context.api.call("hosts.list")).toThrow("closed");
  f.runtime.dispose();
  await vi.waitFor(() => expect(f.context().resources.size).toBe(0));
});

it.each([undefined, () => {}, new Date(), Infinity, "x".repeat(1024 * 1024)])(
  "rejects nontransportable/oversized capture %s without truncation",
  async (value) => {
    const f = fixture(() => ({
      component: Component,
      captureState: () => value,
      restoreState: () => {},
    }));
    await f.runtime.ensure(plugin);
    const view = (await f.runtime.mountView("custom", "main", "activation"))!;
    await expect(view.captureState()).rejects.toThrow("panel.viewState.");
    expect(f.context().signal.aborted).toBe(false);
    f.runtime.dispose();
  },
);

it("renders factory-only declarations through an effect-owned adapter and keeps hidden views mounted", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { useState } = await import("react");
  const cleanup = vi.fn();
  const factory = vi.fn(() => ({
    component: function Counter({ visible }: { visible: boolean }) {
      const [count, setCount] = useState(0);
      return (
        <button onClick={() => setCount(count + 1)}>
          {visible ? "visible" : "hidden"}:{count}
        </button>
      );
    },
    dispose: cleanup,
  }));
  const f = fixture(factory);
  await f.runtime.ensure(plugin);
  const View = f.runtime.view("custom", "main")!;
  expect(View).toBeTypeOf("function");
  const props = {
    pluginId: "custom",
    viewId: "main",
    visible: true,
    resources: f.context().resources,
  };
  const ui = render(<View {...props} />);
  const button = await screen.findByRole("button", { name: "visible:0" });
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.click(button);
  ui.rerender(<View {...props} visible={false} />);
  expect(screen.getByRole("button", { name: "hidden:1" })).toBe(button);
  expect(factory).toHaveBeenCalledOnce();
  expect(f.activate).toHaveBeenCalledOnce();
  expect(f.transport.openView).toHaveBeenCalledOnce();
  ui.unmount();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(f.context().signal.aborted).toBe(false);
  f.runtime.dispose();
});

it("keeps existing registered renderers on their original compatibility path", async () => {
  const f = fixture(() => ({ component: () => null }));
  const Legacy = () => null;
  vi.mocked(f.transport.load).mockResolvedValue({
    activate: (context) => {
      context.views.register("main", Legacy);
    },
    createView: () => ({ component: Component }),
  });
  await f.runtime.ensure(plugin);
  expect(f.runtime.view("custom", "main")).toBe(Legacy);
  expect(f.transport.openView).not.toHaveBeenCalled();
  f.runtime.dispose();
});

it("cancels a single mount before native admission without disposing its parent", async () => {
  const f = fixture(() => ({ component: Component }));
  await f.runtime.ensure(plugin);
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.runtime.mountView("custom", "main", "activation", undefined, controller.signal),
  ).rejects.toThrow("closed");
  expect(f.transport.openView).not.toHaveBeenCalled();
  expect(f.context().signal.aborted).toBe(false);
  f.runtime.dispose();
});

it("effect replay cleans superseded native acquisition without replaying singleton activation", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { StrictMode } = await import("react");
  const cleanup = vi.fn();
  const factory = vi.fn(() => ({ component: () => <span>factory ready</span>, dispose: cleanup }));
  const f = fixture(factory);
  await f.runtime.ensure(plugin);
  const View = f.runtime.view("custom", "main")!;
  const ui = render(
    <StrictMode>
      <View pluginId="custom" viewId="main" visible />
    </StrictMode>,
  );
  await screen.findByText("factory ready");
  expect(f.activate).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledOnce();
  expect(f.transport.openView).toHaveBeenCalledTimes(2);
  ui.unmount();
  expect(cleanup).toHaveBeenCalledOnce();
  f.runtime.dispose();
  await vi.waitFor(() => expect(f.context().resources.size).toBe(0));
  expect(f.transport.close).toHaveBeenCalledTimes(3);
});

it("closes view-local setup failures and stateless restore attempts without stopping the singleton", async () => {
  const f = fixture(() => ({ component: Component }));
  await f.runtime.ensure(plugin);
  await expect(
    f.runtime.mountView("custom", "main", "activation", { value: null }),
  ).rejects.toThrow("viewStateUnavailable");
  expect(f.transport.close).toHaveBeenCalledOnce();
  const view = (await f.runtime.mountView("custom", "main", "activation"))!;
  expect(view.stateful).toBe(false);
  await expect(view.captureState()).rejects.toThrow("viewStateUnavailable");
  view.dispose();
  vi.mocked(f.transport.load).mockResolvedValueOnce({
    activate: () => {},
    createView: () => {
      throw new Error("view setup failed");
    },
  });
  await expect(f.runtime.mountView("custom", "main", "activation")).rejects.toThrow(
    "view setup failed",
  );
  expect(f.transport.fail).not.toHaveBeenCalled();
  expect(f.context().signal.aborted).toBe(false);
  expect(f.transport.close).toHaveBeenCalledTimes(3);
  f.runtime.dispose();
});

it("does not mistake an async factory shell for a synchronous native provider renderer", async () => {
  const f = fixture(() => ({ component: Component }));
  const provider: PluginInfo = {
    ...plugin,
    views: [{ ...plugin.views[0]!, provider: "workbench" }],
  };
  await f.runtime.ensure(provider);
  expect(f.runtime.view("custom", "main")).toBeUndefined();
  expect(f.transport.openView).not.toHaveBeenCalled();
  f.runtime.dispose();
});

it("adapts factory-only async providers without opting synchronous-slot providers or legacy registrations in", async () => {
  const factory = vi.fn(() => ({ component: Component }));
  const f = fixture(factory);
  const provider: PluginInfo = {
    ...plugin,
    views: [
      { ...plugin.views[0]!, provider: "forwarding" },
      { ...plugin.views[0]!, id: "hosts", provider: "hostList" },
      { ...plugin.views[0]!, id: "preferences", provider: "preferences" },
      { ...plugin.views[0]!, id: "layout", provider: "workbench" },
      { ...plugin.views[0]!, id: "registered", provider: "forwarding" },
    ],
  };
  f.activate.mockImplementation((ctx) => {
    ctx.views.register("registered", Component);
  });
  await f.runtime.ensure(provider);
  const View = f.runtime.view("custom", "main")!;
  expect(View).toBeTypeOf("function");
  expect(View).not.toBe(Component);
  expect(f.runtime.isFactoryView("custom", "main", View)).toBe(true);
  expect(f.runtime.isFactoryView("custom", "main", Component)).toBe(false);
  expect(f.runtime.isFactoryView("custom", "registered", Component)).toBe(false);
  expect(f.runtime.view("custom", "registered")).toBe(Component);
  expect(f.runtime.view("custom", "layout")).toBeUndefined();
  const Hosts = f.runtime.view("custom", "hosts")!;
  expect(Hosts).toBeTypeOf("function");
  expect(f.runtime.isFactoryView("custom", "hosts", Hosts)).toBe(true);
  const Preferences = f.runtime.view("custom", "preferences")!;
  expect(Preferences).toBeTypeOf("function");
  expect(f.runtime.isFactoryView("custom", "preferences", Preferences)).toBe(true);
  expect(f.runtime.factoryOwner("custom", "main")).toBeUndefined();
  expect(factory).not.toHaveBeenCalled();
  expect(f.transport.openView).not.toHaveBeenCalled();
  vi.mocked(f.transport.current).mockReturnValue(false);
  expect(f.runtime.isFactoryView("custom", "main", View)).toBe(false);
  f.runtime.stop("custom");
  expect(f.runtime.isFactoryView("custom", "main", View)).toBe(false);
});

it("hands factory state through the panel capsule and waits for real async restore before renderer readiness", async () => {
  const { act, fireEvent, render, screen } = await import("@testing-library/react");
  const { useState } = await import("react");
  const { createPanelViewState, PanelViewStateScope } = await import("@/lib/panels/viewState");
  let restore!: () => void;
  const restored = vi.fn();
  const cleanup = vi.fn();
  const f = fixture(() => {
    let text = "initial";
    return {
      component: function Editor() {
        const [value, set] = useState(text);
        return (
          <input
            aria-label="plugin draft"
            value={value}
            onChange={(event) => {
              text = event.target.value;
              set(text);
            }}
          />
        );
      },
      captureState: async () => {
        await Promise.resolve();
        return { text };
      },
      restoreState: async (value) => {
        restored(value);
        await new Promise<void>((resolve) => {
          restore = resolve;
        });
        text = (value as { text: string }).text;
      },
      dispose: cleanup,
    };
  });
  await f.runtime.ensure(plugin);
  const View = f.runtime.view("custom", "main")!;
  const props = { pluginId: "custom", viewId: "main", visible: true };
  const source = createPanelViewState();
  const ui = render(
    <PanelViewStateScope controller={source}>
      <View {...props} />
    </PanelViewStateScope>,
  );
  await screen.findByRole("textbox", { name: "plugin draft" });
  await source.waitReady(new AbortController().signal);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "source-only draft" } });
  expect(() => source.capture()).toThrow("asyncRequired");
  const capsule = await source.captureAsync();
  expect(capsule.fields["plugin.factory"]).toEqual({
    version: 1,
    pluginId: "custom",
    viewId: "main",
    state: { text: "source-only draft" },
  });
  expect(JSON.stringify(capsule)).not.toContain("activation");
  ui.unmount();
  expect(cleanup).toHaveBeenCalledOnce();
  const destination = createPanelViewState(capsule);
  const target = render(
    <PanelViewStateScope controller={destination}>
      <View {...props} />
    </PanelViewStateScope>,
  );
  const ready = vi.fn();
  const pending = destination.waitReady(new AbortController().signal).then(ready);
  await vi.waitFor(() => expect(restored).toHaveBeenCalledWith({ text: "source-only draft" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(ready).not.toHaveBeenCalled();
  await act(async () => {
    restore();
  });
  await pending;
  expect(screen.getByRole("textbox")).toHaveProperty("value", "source-only draft");
  expect(await destination.captureAsync()).toEqual(capsule);
  expect(f.activate).toHaveBeenCalledOnce();
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.transport.openView).toHaveBeenCalledTimes(2);
  target.unmount();
  source.dispose();
  destination.dispose();
  f.runtime.dispose();
});

it("keeps StrictMode binding replay separate from obsolete loading captures", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { StrictMode } = await import("react");
  const { createPanelViewState, PanelViewStateScope } = await import("@/lib/panels/viewState");
  const f = fixture(() => ({
    component: () => <span>replayed factory</span>,
    captureState: async () => "latest",
    restoreState: async () => {},
  }));
  await f.runtime.ensure(plugin);
  const state = createPanelViewState();
  const View = f.runtime.view("custom", "main")!;
  const ui = render(
    <StrictMode>
      <PanelViewStateScope controller={state}>
        <View pluginId="custom" viewId="main" visible />
      </PanelViewStateScope>
    </StrictMode>,
  );
  await screen.findByText("replayed factory");
  await state.waitReady(new AbortController().signal);
  expect((await state.captureAsync()).fields["plugin.factory"]).toEqual({
    version: 1,
    pluginId: "custom",
    viewId: "main",
    state: "latest",
  });
  ui.unmount();
  state.dispose();
  f.runtime.dispose();
});

it("rejects factory state capture for a stateless legacy-compatible instance instead of inventing an empty capsule", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { createPanelViewState, PanelViewStateScope } = await import("@/lib/panels/viewState");
  const f = fixture(() => ({ component: () => <span>stateless view</span> }));
  await f.runtime.ensure(plugin);
  const state = createPanelViewState();
  const View = f.runtime.view("custom", "main")!;
  const ui = render(
    <PanelViewStateScope controller={state}>
      <View pluginId="custom" viewId="main" visible />
    </PanelViewStateScope>,
  );
  await screen.findByText("stateless view");
  await expect(state.captureAsync()).rejects.toThrow("viewStateUnavailable");
  ui.unmount();
  state.dispose();
  f.runtime.dispose();
});

it("rejects capture/readiness when the real factory setup fails without stopping its activation", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { createPanelViewState, PanelViewStateScope } = await import("@/lib/panels/viewState");
  const { PanelViewBoundary } = await import("@/lib/panels/viewBoundary");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fixture(async () => {
    throw new Error("factory setup failed");
  });
  await f.runtime.ensure(plugin);
  const state = createPanelViewState();
  const View = f.runtime.view("custom", "main")!;
  const failed = vi.fn();
  const ui = render(
    <PanelViewBoundary
      domain="test"
      operation="render"
      fallback={() => <span>isolated failure</span>}
      failed={failed}
    >
      <PanelViewStateScope controller={state}>
        <View pluginId="custom" viewId="main" visible />
      </PanelViewStateScope>
    </PanelViewBoundary>,
  );
  const rejected = expect(state.waitReady(new AbortController().signal)).rejects.toThrow();
  await screen.findByText("isolated failure");
  await rejected;
  expect(failed).toHaveBeenCalledOnce();
  expect(f.context().signal.aborted).toBe(false);
  expect(f.transport.fail).not.toHaveBeenCalled();
  ui.unmount();
  state.dispose();
  f.runtime.dispose();
  log.mockRestore();
});

it("rejects capsule owner/schema mismatch before acquiring a factory view", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { createPanelViewState, PanelViewStateScope } = await import("@/lib/panels/viewState");
  const { PanelViewBoundary } = await import("@/lib/panels/viewBoundary");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fixture(() => ({
    component: Component,
    captureState: () => null,
    restoreState: () => {},
  }));
  await f.runtime.ensure(plugin);
  const View = f.runtime.view("custom", "main")!;
  for (const invalid of [
    { version: 1, pluginId: "other", viewId: "main", state: null },
    { version: 1, pluginId: "custom", viewId: "other", state: null },
    { version: 2, pluginId: "custom", viewId: "main", state: null },
    { version: 1, pluginId: "custom", viewId: "main", state: null, token: "forbidden" },
  ]) {
    const state = createPanelViewState({ version: 1, fields: { "plugin.factory": invalid } });
    const failed = vi.fn();
    const ui = render(
      <PanelViewBoundary
        domain="test"
        operation="render"
        fallback={() => <span>invalid capsule</span>}
        failed={failed}
      >
        <PanelViewStateScope controller={state}>
          <View pluginId="custom" viewId="main" visible />
        </PanelViewStateScope>
      </PanelViewBoundary>,
    );
    expect(screen.getByText("invalid capsule")).toBeTruthy();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: "panel.viewState.invalid" }),
    );
    expect(f.transport.openView).not.toHaveBeenCalled();
    ui.unmount();
    state.dispose();
  }
  f.runtime.dispose();
  log.mockRestore();
});

it("does not re-enter a timed-out plugin capture whose real callback still runs", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const capture = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture(() => ({
    component: Component,
    captureState: capture,
    restoreState: () => {},
  }));
  try {
    await f.runtime.ensure(plugin);
    const view = (await f.runtime.mountView("custom", "main", "activation"))!;
    const timedOut = expect(view.captureState()).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(15000);
    await timedOut;
    await expect(view.captureState()).rejects.toThrow("limit");
    expect(capture).toHaveBeenCalledOnce();
    finish("late");
    for (let i = 0; i < 15; i++) await Promise.resolve();
    const next = view.captureState();
    finish("new");
    expect(await next).toBe("new");
    expect(capture).toHaveBeenCalledTimes(2);
  } finally {
    f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("projects only exact activated factory sidebar owners without leaking activation sessions or starting modules", async () => {
  const f = fixture(() => ({ component: Component }));
  const sidebar = {
    ...plugin,
    views: [
      { id: "main", title: "Factory", kind: "component", location: "sidebar" },
      {
        id: "private",
        title: "No floating",
        kind: "component",
        location: "sidebar",
        allowFloating: false,
      },
      { id: "page", title: "Page", kind: "component", location: "workspace" },
      {
        id: "provider",
        title: "Provider",
        kind: "component",
        location: "sidebar",
        provider: "fileBrowser",
      },
    ],
  } as PluginInfo;
  expect(f.runtime.factoryOwner(plugin.id, "main")).toBeUndefined();
  expect(f.transport.open).not.toHaveBeenCalled();
  await f.runtime.ensure(sidebar);
  const owner = f.runtime.factoryOwner(plugin.id, "main", plugin.fingerprint);
  expect(owner).toEqual({
    pluginId: "custom",
    runtimeId: "boot:1",
    generation: 1,
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  });
  expect(owner).not.toHaveProperty("token");
  expect(owner).not.toHaveProperty("permissions");
  expect(owner).not.toHaveProperty("fingerprint");
  for (const id of ["private", "page", "provider", "undeclared"])
    expect(f.runtime.factoryOwner(plugin.id, id)).toBeUndefined();
  expect(f.runtime.factoryOwner(plugin.id, "main", "changed")).toBeUndefined();
  owner!.entry = "mutated-projection";
  expect(f.runtime.factoryOwner(plugin.id, "main")!.entry).toBe("index.mjs");
  vi.mocked(f.transport.current).mockReturnValue(false);
  expect(f.runtime.factoryOwner(plugin.id, "main")).toBeUndefined();
  f.runtime.stop(plugin.id);
  expect(f.runtime.factoryOwner(plugin.id, "main")).toBeUndefined();
});
it("does not advertise legacy registered sidebars as native factories even when the module also exports createView", async () => {
  const f = fixture(() => ({ component: Component }));
  const sidebar: PluginInfo = { ...plugin, views: [{ ...plugin.views[0]!, location: "sidebar" }] };
  f.activate.mockImplementation((ctx) => {
    ctx.views.register("main", Component);
  });
  await f.runtime.ensure(sidebar);
  expect(f.runtime.view(plugin.id, "main")).toBe(Component);
  expect(f.runtime.factoryOwner(plugin.id, "main")).toBeUndefined();
  f.runtime.dispose();
});

it("reopens a captureless factory only with exact per-instance consent and an explicit reset capsule", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { createPanelViewState, PanelViewStateScope } = await import("@/lib/panels/viewState");
  const { PanelStateLossRequired } = await import("@/lib/panels/stateLoss");
  const f = fixture(() => ({ component: () => <span>captureless factory</span> }));
  await f.runtime.ensure(plugin);
  const source = createPanelViewState();
  const View = f.runtime.view("custom", "main")!;
  const ui = render(
    <PanelViewStateScope controller={source}>
      <View pluginId="custom" viewId="main" visible />
    </PanelViewStateScope>,
  );
  await screen.findByText("captureless factory");
  const error = await source.captureAsync().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PanelStateLossRequired);
  const consent = new Set((error as InstanceType<typeof PanelStateLossRequired>).views);
  const capsule = await source.captureAsync(undefined, { consentedStateLoss: consent });
  expect(capsule.fields["plugin.factory"]).toEqual({
    version: 1,
    pluginId: "custom",
    viewId: "main",
    reset: true,
  });
  await expect(source.captureAsync()).rejects.toThrow("viewStateUnavailable");
  ui.unmount();
  const destination = createPanelViewState(capsule);
  const target = render(
    <PanelViewStateScope controller={destination}>
      <View pluginId="custom" viewId="main" visible />
    </PanelViewStateScope>,
  );
  await screen.findByText("captureless factory");
  await destination.waitReady(new AbortController().signal);
  await expect(
    destination.captureAsync(undefined, { consentedStateLoss: consent }),
  ).rejects.toThrow("viewStateUnavailable");
  expect(f.activate).toHaveBeenCalledOnce();
  expect(f.transport.fail).not.toHaveBeenCalled();
  target.unmount();
  source.dispose();
  destination.dispose();
  f.runtime.dispose();
});
