import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import { createFrontendRuntime, type FrontendTransport } from "@/lib/extensions/frontendRuntime";
import type { FrontendContext, FrontendModule } from "@/lib/extensions/uiSdk";

const plugin = {
  id: "custom",
  fingerprint: "approved",
  status: "running",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [{ id: "hello", title: "Hello" }],
  permissions: ["ui.trusted"],
  views: [{ id: "main", title: "Custom", kind: "component" }],
} as PluginInfo;

function fixture(activate: FrontendModule["activate"] = () => {}) {
  const transport: FrontendTransport = {
    open: vi.fn(async () => ({
      token: crypto.randomUUID(),
      pluginId: plugin.id,
      generation: 1,
      entry: "index.mjs",
      sdkVersion: "0.1.0",
    })),
    close: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    call: vi.fn(async () => undefined as never),
    load: vi.fn(async () => ({ activate })),
    report: vi.fn(),
  };
  return { transport, runtime: createFrontendRuntime(transport) };
}

afterEach(() => vi.useRealTimers());

it("shares the host React instance, hooks and host components without recreating a running module", async () => {
  let context!: FrontendContext;
  const dispose = vi.fn();
  const { runtime, transport } = fixture((ctx) => {
    context = ctx;
    const { react, components } = ctx.sdk;
    function View() {
      const [count, setCount] = react.useState(0);
      return react.createElement(
        components.Button,
        { onClick: () => setCount(count + 1) },
        `Count ${count}`,
      );
    }
    ctx.views.register("main", View);
    ctx.commands.register("hello", async (input) => ({ text: input.name }));
    return dispose;
  });
  await Promise.all([runtime.ensure(plugin), runtime.ensure(plugin)]);
  expect(context.sdk.react).toBe(React);
  expect(transport.open).toHaveBeenCalledOnce();
  const View = runtime.view(plugin.id, "main")!;
  render(<View pluginId={plugin.id} viewId="main" visible />);
  fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
  expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
  await expect(runtime.run(plugin, "hello", { name: "world" })).resolves.toEqual({ text: "world" });
  runtime.dispose();
  await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
  expect(dispose).toHaveBeenCalledOnce();
  expect(context.signal.aborted).toBe(true);
  expect(runtime.view(plugin.id, "main")).toBeUndefined();
});

it("rejects undeclared and duplicate registrations and clears partial activation", async () => {
  const bad = fixture((ctx) => {
    ctx.views.register("main", () => null);
    ctx.commands.register("undeclared", () => {});
  });
  await expect(bad.runtime.ensure(plugin)).rejects.toThrow("undeclaredContribution");
  expect(bad.runtime.view(plugin.id, "main")).toBeUndefined();
  expect(bad.transport.close).toHaveBeenCalledOnce();
  const duplicate = fixture((ctx) => {
    ctx.commands.register("hello", () => {});
    ctx.commands.register("hello", () => {});
  });
  await expect(duplicate.runtime.ensure(plugin)).rejects.toThrow("duplicateContribution");
});

it("cleans a session arriving after stop and never starts its JavaScript", async () => {
  const f = fixture();
  let finish!: (value: Awaited<ReturnType<FrontendTransport["open"]>>) => void;
  f.transport.open = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<FrontendTransport["open"]>>>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.runtime.ensure(plugin);
  const rejected = expect(pending).rejects.toThrow("extension.scope.closed");
  f.runtime.stop(plugin.id);
  await rejected;
  finish({
    token: "late",
    pluginId: plugin.id,
    generation: 1,
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  });
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledExactlyOnceWith("late"));
  expect(f.transport.load).not.toHaveBeenCalled();
});

it("times out activation, releases partial contributions and cleans a late activation result", async () => {
  vi.useFakeTimers();
  let context!: FrontendContext;
  let finish!: (cleanup: () => void) => void;
  const cleanup = vi.fn();
  const f = fixture((ctx) => {
    context = ctx;
    ctx.views.register("main", () => null);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.runtime.ensure(plugin);
  const rejected = expect(pending).rejects.toThrow("extension.scope.timeout");
  await vi.advanceTimersByTimeAsync(15_001);
  await rejected;
  expect(context.signal.aborted).toBe(true);
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
  expect(f.transport.fail).toHaveBeenCalledOnce();
  expect(() => context.commands.register("hello", () => {})).toThrow("extension.scope.closed");
  finish(cleanup);
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("rejects SDK mismatch before execution and releases the native session", async () => {
  const f = fixture();
  f.transport.open = vi.fn(async () => ({
    token: "unsupported",
    pluginId: plugin.id,
    generation: 1,
    entry: "index.mjs",
    sdkVersion: "2.0.0",
  }));
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("sdkMismatch");
  expect(f.transport.load).not.toHaveBeenCalled();
  expect(f.transport.close).toHaveBeenCalledExactlyOnceWith("unsupported");
});

it("publishes views only after activation succeeds and preserves them on unrelated approval", async () => {
  let finish!: () => void;
  const f = fixture((ctx) => {
    ctx.views.register("main", () => null);
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.runtime.ensure(plugin);
  await vi.waitFor(() => expect(f.transport.load).toHaveBeenCalledOnce());
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
  finish();
  await pending;
  const View = f.runtime.view(plugin.id, "main");
  f.runtime.reconcileSecurity({
    restricted: false,
    grants: { custom: ["ui.trusted"], other: [] },
  } as never);
  expect(f.runtime.view(plugin.id, "main")).toBe(View);
  expect(f.transport.close).not.toHaveBeenCalled();
  f.runtime.reconcileSecurity({ restricted: false, grants: { other: [] } } as never);
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledOnce());
});

it("restricts stopped or absent modules and stops only the changed owner on reconciliation", async () => {
  const f = fixture((ctx) => {
    ctx.views.register("main", () => null);
  });
  await f.runtime.ensure(plugin);
  f.runtime.reconcile([{ ...plugin, fingerprint: "changed" }], false);
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
  await expect(f.runtime.ensure({ ...plugin, status: "stopped" })).rejects.toThrow(
    "plugin.notRunning",
  );
  await f.runtime.ensure(plugin);
  f.runtime.reconcile([plugin], true);
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
});
