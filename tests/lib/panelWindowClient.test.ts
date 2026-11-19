import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPanelWindowClient, initializePanelWindow } from "@/lib/panels/windowClient";
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockReset();
});
afterEach(() => vi.restoreAllMocks());
const identity = { windowId: "panel-one", document: "native-document" };
it("initializes through native identity and never passes a client-supplied window label as authority", async () => {
  native.invoke.mockResolvedValueOnce(identity).mockResolvedValueOnce({ panels: [] });
  const client = await initializePanelWindow();
  await client.snapshot();
  expect(native.invoke.mock.calls).toEqual([
    ["panel_window_initialize"],
    ["panel_window_control", { document: "native-document", request: { action: "snapshot" } }],
  ]);
  expect(client.windowId).toBe("panel-one");
  client.dispose();
});
it("fences in-flight replies and rejects mutations after disposal", async () => {
  let resolve!: (value: unknown) => void;
  native.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const client = createPanelWindowClient(identity);
  const pending = client.snapshot();
  client.dispose();
  resolve({ panels: [] });
  await expect(pending).rejects.toThrow("disposed");
  await expect(client.control({ action: "ready" })).rejects.toThrow("disposed");
  expect(native.invoke).toHaveBeenCalledTimes(1);
});
it("releases late subscriptions, is idempotent, and never delivers callbacks after disposal", async () => {
  let receive!: () => void, done!: (stop: () => void) => void;
  const stop = vi.fn(),
    changed = vi.fn();
  native.listen.mockImplementation((_name, callback: () => void) => {
    receive = callback;
    return new Promise((resolve) => {
      done = resolve;
    });
  });
  const client = createPanelWindowClient(identity);
  const pending = client.subscribe(changed);
  client.dispose();
  done(stop);
  await pending;
  receive();
  expect(changed).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);
  client.dispose();
  expect(stop).toHaveBeenCalledTimes(1);
});
it("subscribes to advisory events without reading or emitting secrets", async () => {
  const stop = vi.fn(),
    close = vi.fn();
  let receive!: () => void;
  native.listen.mockImplementation((_name, callback: () => void) => {
    receive = callback;
    return Promise.resolve(stop);
  });
  const client = createPanelWindowClient(identity);
  await client.onClose(close);
  receive();
  expect(close).toHaveBeenCalledTimes(1);
  client.dispose();
  receive();
  expect(close).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(native.invoke).not.toHaveBeenCalled();
});

it("makes explicit unsubscribe and document disposal share one idempotent release", async () => {
  const stop = vi.fn();
  native.listen.mockResolvedValue(stop);
  const client = createPanelWindowClient(identity);
  const release = await client.subscribe(vi.fn());
  release();
  release();
  client.dispose();
  release();
  expect(stop).toHaveBeenCalledTimes(1);
});
it("binds the closed resource/focus gateways to native document identity and the exact lease", async () => {
  const client = createPanelWindowClient(identity);
  const lease = { panelId: "connections", windowId: identity.windowId, generation: 5 };
  native.invoke.mockResolvedValue(null);
  await client.disconnect(lease, "session-1");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_disconnect", {
    document: identity.document,
    lease,
    sessionId: "session-1",
  });
  await client.focus("connections");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_focus", {
    document: identity.document,
    panelId: "connections",
  });
  client.dispose();
  await expect(client.focus("connections")).rejects.toThrow("disposed");
  await expect(client.disconnect(lease, "session-1")).rejects.toThrow("disposed");
});
