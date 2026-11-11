import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import type * as FrontendRuntimeModule from "@/lib/extensions/frontendRuntime";

const fixture = vi.hoisted(() => ({ activate: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: {}, isTauri: () => false }));
vi.mock("@/features/plugins/PluginSecuritySection", () => ({
  PluginRestrictedAction: () => <p>Restricted</p>,
}));
vi.mock("@/lib/extensions/frontendRuntime", async (original) => {
  const module = await original<typeof FrontendRuntimeModule>();
  return {
    ...module,
    frontendRuntime: module.createFrontendRuntime({
      current: () => true,
      open: async (pluginId, runtimeId) => ({
        runtimeId,
        token: crypto.randomUUID(),
        pluginId,
        generation: 1,
        entry: "index.mjs",
        sdkVersion: "0.1.0",
      }),
      close: fixture.close,
      ready: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      load: async () => ({ activate: fixture.activate }),
      call: async () => undefined as never,
      report: vi.fn(),
    }),
  };
});

import "@/i18n/i18n";
import { PluginComponentView } from "@/features/plugins/PluginComponentView";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import type { FrontendContext, FrontendViewProps } from "@/lib/extensions/uiSdk";
import type { UiResourceScope } from "@/lib/extensions/contracts/runtime/resources";
import { deferred } from "../fixtures/plugins";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createWorkbenchSurfaces } from "@/components/layout/WorkbenchSurfaces";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

const plugin = {
  name: "Custom",
  version: "1.0.0",
  apiVersion: 1,
  description: null,
  error: null,
  path: "plugins/custom",
  id: "custom",
  fingerprint: "approved",
  runtimeId: "boot:1",
  status: "running",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [],
  views: [{ id: "main", title: "Main", kind: "component" }],
  permissions: ["ui.trusted"],
} as PluginInfo;

beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: false } }));
});
afterEach(() => {
  cleanup();
  frontendRuntime.dispose();
});

it("reports missing registered views after activation instead of loading indefinitely", async () => {
  fixture.activate.mockImplementation(() => {});
  render(<PluginComponentView pluginId={plugin.id} viewId="main" />);
  expect((await screen.findByRole("alert")).textContent).toContain("did not register this view");
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  expect(fixture.activate).toHaveBeenCalledOnce();
});

it("preserves hook state when another plugin publishes a contribution", async () => {
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    ctx.views.register("main", function View() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
    });
  });
  render(<PluginComponentView pluginId={plugin.id} viewId="main" />);
  fireEvent.click(await screen.findByRole("button", { name: "Count 0" }));
  await act(() => frontendRuntime.ensure({ ...plugin, id: "other" }));
  expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
  expect(fixture.activate).toHaveBeenCalledTimes(2);
});

it("provides refresh after a component render error", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const start = vi.spyOn(usePlugins.getState(), "start").mockResolvedValue();
  try {
    fixture.activate.mockImplementation((ctx: FrontendContext) => {
      ctx.views.register("main", () => {
        throw new Error("broken component");
      });
    });
    render(<PluginComponentView pluginId={plugin.id} viewId="main" />);
    expect((await screen.findByRole("alert")).textContent).toContain("broken component");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(plugin.id));
  } finally {
    consoleError.mockRestore();
    start.mockRestore();
  }
});

it("automatically owns separate view lifetimes, retains hidden views and cleans forgotten late acquisitions on close", async () => {
  const scopes: UiResourceScope[] = [];
  const delayed = deferred<string>();
  const released = vi.fn();
  let pending: Promise<unknown> | undefined;
  let context!: FrontendContext;
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    context = ctx;
    ctx.views.register("main", function View({ resources }: FrontendViewProps) {
      useEffect(() => {
        const scope = resources!;
        scopes.push(scope);
        if (scopes.length === 1)
          pending = scope.acquire(() => delayed.promise, released).catch((error) => error);
        // No explicit dispose: the host owns this instance's lifetime.
      }, [resources]);
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(count + 1)}>View count {count}</button>;
    });
  });
  const content = (first = true, visible = true) => (
    <>
      {first && (
        <PluginComponentView key="first" pluginId={plugin.id} viewId="main" visible={visible} />
      )}
      <PluginComponentView key="second" pluginId={plugin.id} viewId="main" />
    </>
  );
  const ui = render(content());
  await waitFor(() => expect(scopes).toHaveLength(2));
  const first = scopes[0]!,
    second = scopes[1]!;
  fireEvent.click(screen.getAllByRole("button", { name: "View count 0" })[1]!);
  ui.rerender(content(true, false));
  expect(scopes).toHaveLength(2);
  expect(scopes.every((scope) => !scope.signal.aborted)).toBe(true);
  ui.rerender(content(false));
  expect(await pending).toMatchObject({ code: "extension.scope.closed" });
  expect(first.size).toBe(1);
  expect(second.signal.aborted).toBe(false);
  expect(context.signal.aborted).toBe(false);
  expect(screen.getByRole("button", { name: "View count 1" })).toBeTruthy();
  delayed.resolve("view's late result");
  await waitFor(() => expect(released).toHaveBeenCalledExactlyOnceWith("view's late result"));
  expect(first.size).toBe(0);
  await act(async () => {
    usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] });
    frontendRuntime.stop(plugin.id);
  });
  expect(second.signal.aborted).toBe(true);
  expect(context.resources.size).toBe(0);
});

it("allocates nothing for an abandoned suspended render and never revives a closed scope on StrictMode replay", async () => {
  const observed: UiResourceScope[] = [];
  let context!: FrontendContext;
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    context = ctx;
    ctx.views.register("main", function View({ resources }: FrontendViewProps) {
      useEffect(() => {
        observed.push(resources!);
      }, [resources]);
      return <p>Committed instance</p>;
    });
  });
  await frontendRuntime.ensure(plugin);
  const initial = context.resources.size;
  const waitForever = new Promise(() => {});
  function Suspended(): never {
    throw waitForever;
  }
  const ui = render(
    <Suspense fallback={<p>Deferred</p>}>
      <PluginComponentView pluginId={plugin.id} viewId="main" />
      <Suspended />
    </Suspense>,
  );
  expect(screen.getByText("Deferred")).toBeTruthy();
  expect(context.resources.size).toBe(initial);
  expect(observed).toHaveLength(0);
  ui.rerender(
    <StrictMode>
      <PluginComponentView pluginId={plugin.id} viewId="main" />
    </StrictMode>,
  );
  await screen.findByText("Committed instance");
  expect(context.resources.size).toBe(initial + 1);
  const current = observed.at(-1)!;
  expect(current.signal.aborted).toBe(false);
  ui.unmount();
  expect(observed.every((scope) => scope.signal.aborted)).toBe(true);
  expect(context.resources.size).toBe(initial);
});

it("reports quota exhaustion without retrying or resetting an already mounted sibling", async () => {
  const observed: UiResourceScope[] = [];
  let context!: FrontendContext;
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    context = ctx;
    ctx.views.register("main", function View({ resources }: FrontendViewProps) {
      useEffect(() => {
        observed.push(resources!);
      }, [resources]);
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(count + 1)}>Stable count {count}</button>;
    });
  });
  const content = (second: boolean) => (
    <>
      <PluginComponentView key="first" pluginId={plugin.id} viewId="main" />
      {second && <PluginComponentView key="second" pluginId={plugin.id} viewId="main" />}
    </>
  );
  const ui = render(content(false));
  fireEvent.click(await screen.findByRole("button", { name: "Stable count 0" }));
  const cleanup = [];
  while (context.resources.size < 128) cleanup.push(context.resources.use(() => {}));
  ui.rerender(content(true));
  expect((await screen.findByRole("alert")).textContent).toContain("extension.scope.limit");
  expect(screen.getByRole("button", { name: "Stable count 1" })).toBeTruthy();
  expect(observed).toHaveLength(1);
  expect(observed[0]!.signal.aborted).toBe(false);
  expect(fixture.activate).toHaveBeenCalledOnce();
  cleanup.forEach((release) => release());
});

it("does not attach a retired admission failure to the replacement module", async () => {
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    ctx.views.register("main", () => <p>Replacement mounted</p>);
  });
  const original = frontendRuntime.viewScope;
  const admission = vi.spyOn(frontendRuntime, "viewScope").mockImplementation(original);
  // Keep exactly the first admission retired; later generations use the real admission.
  admission.mockImplementationOnce(() => {
    frontendRuntime.stop(plugin.id);
    throw new Error("extension.scope.closed");
  });
  try {
    render(<PluginComponentView pluginId={plugin.id} viewId="main" />);
    await screen.findByText("Replacement mounted");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fixture.activate).toHaveBeenCalledTimes(2);
  } finally {
    admission.mockRestore();
  }
});

it("retires a mounted view and its forgotten cleanup on render failure", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const cleaned = vi.fn();
  let scope!: UiResourceScope;
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    ctx.views.register("main", function View({ resources }: FrontendViewProps) {
      scope = resources!;
      useEffect(() => {
        resources!.use(cleaned);
      }, [resources]);
      const [broken, setBroken] = useState(false);
      if (broken) throw new Error("mounted view failed");
      return <button onClick={() => setBroken(true)}>Break view</button>;
    });
  });
  try {
    render(<PluginComponentView pluginId={plugin.id} viewId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Break view" }));
    expect((await screen.findByRole("alert")).textContent).toContain("mounted view failed");
    expect(scope.signal.aborted).toBe(true);
    expect(cleaned).toHaveBeenCalledOnce();
  } finally {
    consoleError.mockRestore();
  }
});

it("binds real provider scopes to selection generations while retaining the native editor through StrictMode and batched restore", async () => {
  const scopes: UiResourceScope[] = [];
  let context!: FrontendContext;
  const providerPlugin = {
    ...plugin,
    views: [{ ...plugin.views[0]!, provider: "workbench" }],
  } as PluginInfo;
  usePlugins.setState({ items: [providerPlugin] });
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    context = ctx;
    ctx.views.register("main", function View({ resources, workbench, visible }: FrontendViewProps) {
      useEffect(() => {
        scopes.push(resources!);
      }, [resources]);
      const Workspace = workbench!.Workspace;
      return (
        <section aria-label="scoped layout" hidden={!visible}>
          <Workspace />
        </section>
      );
    });
  });
  await frontendRuntime.ensure(providerPlugin);
  const initial = context.resources.size;
  function Fixture({ visible = true }: { visible?: boolean }) {
    const [surfaces] = useState(createWorkbenchSurfaces);
    const Workspace = surfaces.slots.Workspace;
    return (
      <>
        <ProviderSurface
          target="workbench"
          slots={surfaces.slots}
          visible={visible}
          validate={surfaces.hasWorkspace}
          subscribe={surfaces.subscribe}
        >
          <Workspace />
        </ProviderSurface>
        {createPortal(
          <textarea aria-label="native editor" defaultValue="draft" />,
          surfaces.container("workspace"),
        )}
      </>
    );
  }
  const selected = { workbench: { pluginId: plugin.id, viewId: "main" } };
  const ui = render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  const editor = screen.getByLabelText("native editor");
  fireEvent.change(editor, { target: { value: "unsaved" } });
  await act(async () =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
  );
  expect((await screen.findByRole("region", { name: "scoped layout" })).contains(editor)).toBe(
    true,
  );
  const first = scopes.at(-1)!;
  ui.rerender(
    <StrictMode>
      <Fixture visible={false} />
    </StrictMode>,
  );
  expect(first.signal.aborted).toBe(false);
  expect(scopes.every((scope) => scope === first || scope.signal.aborted)).toBe(true);
  await act(async () => {
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } }));
    expect(first.signal.aborted).toBe(true);
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } }));
  });
  const replacement = scopes.at(-1)!;
  expect(replacement).not.toBe(first);
  expect(replacement.signal.aborted).toBe(false);
  expect(screen.getByLabelText("native editor")).toBe(editor);
  expect(editor).toHaveProperty("value", "unsaved");
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(replacement.signal.aborted).toBe(true);
  expect(context.resources.size).toBe(initial);
  expect(screen.getByLabelText("native editor")).toBe(editor);
  expect(screen.queryByRole("alert")).toBeNull();
});
