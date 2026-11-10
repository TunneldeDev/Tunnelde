import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
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
import type { FrontendContext } from "@/lib/extensions/uiSdk";
import type { UiResourceScope } from "@/lib/extensions/contracts/runtime/resources";
import { deferred } from "../fixtures/plugins";

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

it("lets mounted views own separate lifetimes, retain them while hidden and clean late acquisitions on close", async () => {
  const scopes: UiResourceScope[] = [];
  const delayed = deferred<string>();
  const released = vi.fn();
  let pending: Promise<unknown> | undefined;
  let context!: FrontendContext;
  fixture.activate.mockImplementation((ctx: FrontendContext) => {
    context = ctx;
    ctx.views.register("main", function View() {
      useEffect(() => {
        const scope = ctx.resources.child!();
        scopes.push(scope);
        if (scopes.length === 1)
          pending = scope.acquire(() => delayed.promise, released).catch((error) => error);
        return () => scope.dispose();
      }, []);
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
