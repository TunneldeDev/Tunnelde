import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
      open: async (pluginId) => ({
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

const plugin = {
  name: "Custom",
  version: "1.0.0",
  apiVersion: 1,
  description: null,
  error: null,
  path: "plugins/custom",
  id: "custom",
  fingerprint: "approved",
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
