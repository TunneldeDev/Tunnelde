import { expect, it, vi } from "vitest";
import { callFrontend, type NativeRequestInvoke } from "@/lib/extensions/runtime/requests/frontend";

function fixture() {
  let release!: (value: unknown) => void;
  const dispatch = new Promise((resolve) => {
    release = resolve;
  });
  const invoke = vi.fn(async (command: string) => {
    if (command === "plugin_frontend_prepare_call") return "request";
    if (command === "plugin_frontend_call") return dispatch;
    return true;
  });
  return {
    invoke,
    release,
    run: (signal?: AbortSignal) =>
      callFrontend(invoke as NativeRequestInvoke, vi.fn(), "owner", "ui.confirm", {}, signal),
  };
}

it("cancels only the reserved owner request and forwards its ticket to dispatch", async () => {
  const f = fixture(),
    owner = new AbortController();
  const pending = f.run(owner.signal);
  await vi.waitFor(() =>
    expect(f.invoke).toHaveBeenCalledWith("plugin_frontend_call", {
      token: "owner",
      requestId: "request",
      method: "ui.confirm",
      params: {},
    }),
  );
  owner.abort();
  expect(f.invoke).toHaveBeenLastCalledWith("plugin_frontend_cancel_call", {
    token: "owner",
    requestId: "request",
  });
  f.release(false);
  await pending;
  expect(
    f.invoke.mock.calls.filter(([method]) => method === "plugin_frontend_cancel_call"),
  ).toHaveLength(1);
});

it("releases a reservation arriving after cancellation without dispatching", async () => {
  let reserve!: (value: string) => void;
  const reply = new Promise<string>((resolve) => {
    reserve = resolve;
  });
  const invoke = vi.fn((command: string) =>
    command === "plugin_frontend_prepare_call" ? reply : Promise.resolve(true),
  );
  const owner = new AbortController();
  const pending = callFrontend(
    invoke as NativeRequestInvoke,
    vi.fn(),
    "owner",
    "ui.confirm",
    {},
    owner.signal,
  );
  owner.abort();
  reserve("late");
  await expect(pending).rejects.toThrow("cancelled");
  expect(invoke.mock.calls.map(([method]) => method)).toEqual([
    "plugin_frontend_prepare_call",
    "plugin_frontend_cancel_call",
  ]);
});

it("does not allocate for an already aborted signal and releases failed dispatch", async () => {
  const f = fixture(),
    owner = new AbortController();
  owner.abort();
  await expect(f.run(owner.signal)).rejects.toThrow("cancelled");
  expect(f.invoke).not.toHaveBeenCalled();
  const invoke = vi.fn(async (command: string) => {
    if (command === "plugin_frontend_prepare_call") return "ticket";
    if (command === "plugin_frontend_call") throw new Error("revoked");
    return false;
  });
  await expect(
    callFrontend(invoke as NativeRequestInvoke, vi.fn(), "owner", "storage.set", {}),
  ).rejects.toThrow("revoked");
  expect(invoke).toHaveBeenLastCalledWith("plugin_frontend_cancel_call", {
    token: "owner",
    requestId: "ticket",
  });
});

it("reports cleanup errors without replacing the operation result", async () => {
  const report = vi.fn();
  const invoke = vi.fn(async (command: string) => {
    if (command === "plugin_frontend_prepare_call") return "ticket";
    if (command === "plugin_frontend_cancel_call") throw new Error("closed");
    return 42;
  });
  expect(
    await callFrontend(invoke as NativeRequestInvoke, report, "owner", "storage.get", {}),
  ).toBe(42);
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
});
