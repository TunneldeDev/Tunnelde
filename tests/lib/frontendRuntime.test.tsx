import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import { createFrontendRuntime, type FrontendTransport } from "@/lib/extensions/frontendRuntime";
import { backgroundTasksBlockSuspension, useBackgroundTasks } from "@/lib/tasks/background";
import type { FrontendContext, FrontendModule } from "@/lib/extensions/uiSdk";

const plugin = {
  id: "custom",
  fingerprint: "approved",
  runtimeId: "boot:1",
  status: "running",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [{ id: "hello", title: "Hello" }],
  permissions: ["ui.trusted"],
  views: [{ id: "main", title: "Custom", kind: "component" }],
} as PluginInfo;

function fixture(activate: FrontendModule["activate"] = () => {}) {
  const transport: FrontendTransport = {
    current: vi.fn(() => true),
    open: vi.fn(async () => ({
      token: crypto.randomUUID(),
      pluginId: plugin.id,
      generation: 1,
      runtimeId: "boot:1",
      entry: "index.mjs",
      sdkVersion: "0.1.0",
    })),
    close: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    call: vi.fn(async () => undefined as never),
    load: vi.fn(async () => ({ activate })),
    report: vi.fn(),
  };
  return { transport, runtime: createFrontendRuntime(transport) };
}

it("admits mounted scopes only for the exact activated module, renderer and package fingerprint", async () => {
  let context!: FrontendContext;
  const View = () => null;
  const { runtime, transport } = fixture((ctx) => {
    context = ctx;
    ctx.views.register("main", View);
  });
  expect(() => runtime.viewScope(plugin.id, "main", undefined, View)).toThrow("closed");
  await runtime.ensure(plugin);
  const token = runtime.token(plugin.id)!;
  const before = context.resources.size;
  for (const [viewId, candidateToken, component, fingerprint] of [
    ["missing", token, View, "approved"],
    ["main", "stale", View, "approved"],
    ["main", token, () => null, "approved"],
    ["main", token, View, "changed"],
  ] as const)
    expect(() => runtime.viewScope(plugin.id, viewId, candidateToken, component, fingerprint)).toThrow("closed");
  expect(context.resources.size).toBe(before);
  const first = runtime.viewScope(plugin.id, "main", token, View, "approved");
  const second = runtime.viewScope(plugin.id, "main", token, View, "approved");
  expect(first).not.toBe(second);
  first.dispose();
  expect(second.signal.aborted).toBe(false);
  vi.mocked(transport.current).mockReturnValue(false);
  expect(() => runtime.viewScope(plugin.id, "main", token, View, "approved")).toThrow("closed");
  runtime.stop(plugin.id);
  expect(second.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(context.resources.size).toBe(0));
});

afterEach(() => vi.useRealTimers());

it("replaces an identical-package module on runtime change and rejects stale ensure without disposing its replacement", async () => {
  const cleanup = vi.fn();
  const f = fixture(() => cleanup);
  let selected = plugin;
  f.transport.current = (candidate) => candidate.runtimeId === selected.runtimeId;
  f.transport.open = vi.fn(async (pluginId, runtimeId) => ({
    token: crypto.randomUUID(),
    pluginId,
    runtimeId,
    generation: 1,
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  }));
  await f.runtime.ensure(plugin);
  const oldToken = f.runtime.token(plugin.id);
  selected = { ...plugin, runtimeId: "boot:2" };
  f.runtime.reconcile([selected], false);
  await f.runtime.ensure(selected);
  const replacement = f.runtime.token(plugin.id);
  expect(replacement).not.toBe(oldToken);
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("extension.scope.closed");
  expect(f.runtime.token(plugin.id)).toBe(replacement);
  expect(f.transport.open).toHaveBeenCalledTimes(2);
  f.runtime.dispose();
});

it("rejects a frontend session from the wrong runtime before loading JavaScript", async () => {
  const f = fixture();
  vi.mocked(f.transport.open).mockResolvedValueOnce({
    token: "old",
    pluginId: plugin.id,
    runtimeId: "boot:old",
    generation: 1,
    entry: "index.mjs",
    sdkVersion: "0.1.0",
  });
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("extension.scope.closed");
  expect(f.transport.load).not.toHaveBeenCalled();
  expect(f.transport.ready).not.toHaveBeenCalled();
  expect(f.transport.close).toHaveBeenCalledExactlyOnceWith("old");
});

it("calls domain RPC only through an existing activated generation and discards results after retirement", async () => {
  const { runtime, transport } = fixture();
  await expect(runtime.call(plugin.id, "unknown", "preferences.schema")).rejects.toThrow("closed");
  expect(transport.open).not.toHaveBeenCalled();
  await runtime.ensure(plugin);
  const token = runtime.token(plugin.id)!;
  await expect(runtime.call(plugin.id, "wrong", "preferences.snapshot")).rejects.toThrow("closed");
  expect(transport.call).not.toHaveBeenCalled();
  let finish!: (value: unknown) => void;
  vi.mocked(transport.call).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = runtime.call(plugin.id, token, "preferences.snapshot");
  const rejected = expect(pending).rejects.toThrow("closed");
  runtime.stop(plugin.id);
  await rejected;
  finish({ revision: "late" });
  await runtime.ensure(plugin);
  await expect(runtime.call(plugin.id, token, "preferences.snapshot")).rejects.toThrow("closed");
  runtime.dispose();
});

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
  expect(bad.transport.ready).not.toHaveBeenCalled();
  const duplicate = fixture((ctx) => {
    ctx.commands.register("hello", () => {});
    ctx.commands.register("hello", () => {});
  });
  await expect(duplicate.runtime.ensure(plugin)).rejects.toThrow("duplicateContribution");
});

it("waits for native readiness acknowledgement before exposing views or running commands", async () => {
  let activate!: () => void;
  let acknowledge!: () => void;
  const command = vi.fn();
  const f = fixture((ctx) => {
    ctx.views.register("main", () => null);
    ctx.commands.register("hello", command);
    return new Promise<void>((resolve) => {
      activate = resolve;
    });
  });
  f.transport.ready = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const pending = f.runtime.ensure(plugin);
  await vi.waitFor(() => expect(f.transport.load).toHaveBeenCalledOnce());
  expect(f.transport.ready).not.toHaveBeenCalled();
  activate();
  await vi.waitFor(() => expect(f.transport.ready).toHaveBeenCalledOnce());
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
  const running = f.runtime.run(plugin, "hello", {});
  expect(command).not.toHaveBeenCalled();
  acknowledge();
  await Promise.all([pending, running]);
  expect(f.runtime.view(plugin.id, "main")).toBeTypeOf("function");
  expect(command).toHaveBeenCalledOnce();
  f.runtime.dispose();
});

it("cleans activation and the native session when the readiness acknowledgement fails", async () => {
  const cleanup = vi.fn();
  const f = fixture((ctx) => {
    ctx.views.register("main", () => null);
    return cleanup;
  });
  f.transport.ready = vi.fn(async () => {
    throw Error("pluginSecurity.changed");
  });
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("pluginSecurity.changed");
  expect(f.runtime.view(plugin.id, "main")).toBeUndefined();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(f.transport.fail).toHaveBeenCalledOnce();
  expect(f.transport.close).toHaveBeenCalledOnce();
});

it("bounds readiness acknowledgement and releases a session that never acknowledges", async () => {
  vi.useFakeTimers();
  const cleanup = vi.fn();
  const f = fixture(() => cleanup);
  f.transport.ready = vi.fn(() => new Promise<void>(() => {}));
  const pending = expect(f.runtime.ensure(plugin)).rejects.toThrow("extension.scope.timeout");
  await vi.advanceTimersByTimeAsync(15_001);
  await pending;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(f.transport.fail).toHaveBeenCalledOnce();
  expect(f.transport.close).toHaveBeenCalledOnce();
});

it("does not publish a stopped module or retire its replacement when an old acknowledgement arrives", async () => {
  let acknowledge!: () => void;
  const f = fixture((ctx) => {
    ctx.views.register("main", () => null);
  });
  f.transport.ready = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const old = expect(f.runtime.ensure(plugin)).rejects.toThrow("extension.scope.closed");
  await vi.waitFor(() => expect(f.transport.ready).toHaveBeenCalledOnce());
  const oldToken = f.runtime.token(plugin.id);
  f.runtime.stop(plugin.id);
  await old;
  await f.runtime.ensure(plugin);
  const newToken = f.runtime.token(plugin.id);
  const newView = f.runtime.view(plugin.id, "main");
  expect(newToken).not.toBe(oldToken);
  acknowledge();
  await Promise.resolve();
  expect(f.runtime.token(plugin.id)).toBe(newToken);
  expect(f.runtime.view(plugin.id, "main")).toBe(newView);
  expect(f.transport.fail).not.toHaveBeenCalled();
  expect(f.transport.close).toHaveBeenCalledExactlyOnceWith(oldToken);
  f.runtime.dispose();
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
    runtimeId: "boot:1",
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
    runtimeId: "boot:1",
    entry: "index.mjs",
    sdkVersion: "2.0.0",
  }));
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("sdkMismatch");
  expect(f.transport.load).not.toHaveBeenCalled();
  expect(f.transport.close).toHaveBeenCalledExactlyOnceWith("unsupported");
});

it("rejects registrations during asynchronous failure retirement", async () => {
  let context!: FrontendContext;
  let fail!: () => void;
  const f = fixture((ctx) => {
    context = ctx;
    throw new Error("activation failed");
  });
  f.transport.fail = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        fail = resolve;
      }),
  );
  const pending = f.runtime.ensure(plugin);
  const rejected = expect(pending).rejects.toThrow("activation failed");
  await vi.waitFor(() => expect(f.transport.fail).toHaveBeenCalledOnce());
  expect(() => context.views.register("main", () => null)).toThrow("extension.scope.closed");
  expect(() => context.api.call("app.info")).toThrow("extension.scope.closed");
  fail();
  await rejected;
  expect(f.transport.close).toHaveBeenCalledOnce();
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

it("revokes owned task reporting on stop and keeps hidden JS alive until settlement", async () => {
  let context!: FrontendContext;
  const f = fixture((ctx) => {
    context = ctx;
  });
  await f.runtime.ensure(plugin);
  let finish!: () => void;
  let taskSignal!: AbortSignal;
  const result = context.backgroundTasks!.run(
    { title: "Hidden owned work", visible: false },
    (task) => {
      taskSignal = task.signal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  const handled = expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(
    useBackgroundTasks.getState().items.find((item) => item.title === "Hidden owned work")
      ?.pluginId,
  ).toBe(plugin.id);
  expect(backgroundTasksBlockSuspension()).toBe(true);
  f.runtime.stop(plugin.id);
  expect(taskSignal.aborted).toBe(true);
  expect(backgroundTasksBlockSuspension()).toBe(true);
  await expect(context.backgroundTasks!.run({ title: "Late work" }, () => {})).rejects.toThrow(
    "closed",
  );
  finish();
  await handled;
  expect(backgroundTasksBlockSuspension()).toBe(false);
});

it("cancels tasks started by a failed activation without claiming uncooperative work has stopped", async () => {
  let finish!: () => void;
  let pending!: Promise<unknown>;
  let signal!: AbortSignal;
  const f = fixture((ctx) => {
    pending = ctx
      .backgroundTasks!.run({ title: "Partial activation", visible: false }, (task) => {
        signal = task.signal;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      })
      .catch((error) => error);
    throw Error("Activation failed");
  });
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("Activation failed");
  expect(signal.aborted).toBe(true);
  expect(backgroundTasksBlockSuspension()).toBe(true);
  finish();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(backgroundTasksBlockSuspension()).toBe(false);
});

it("retires nested scopes on a failed activation and keeps late cleanup observable", async () => {
  let context!: FrontendContext;
  let finish!: (value: string) => void;
  let pending!: Promise<unknown>;
  const released = vi.fn();
  const f = fixture((ctx) => {
    context = ctx;
    const child = ctx.resources.child!().child!();
    pending = child
      .acquire(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        released,
      )
      .catch((error) => error);
    throw Error("Activation failed after creating child");
  });
  await expect(f.runtime.ensure(plugin)).rejects.toThrow("Activation failed after creating child");
  expect(await pending).toMatchObject({ code: "extension.scope.closed" });
  expect(context.signal.aborted).toBe(true);
  expect(context.resources.size).toBe(1);
  finish("late descendant");
  await vi.waitFor(() => expect(released).toHaveBeenCalledExactlyOnceWith("late descendant"));
  expect(context.resources.size).toBe(0);
  expect(f.transport.report).toHaveBeenCalledWith(plugin.id, "activate", expect.any(Error));
});
