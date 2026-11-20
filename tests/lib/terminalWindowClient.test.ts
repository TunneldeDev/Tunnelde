import { beforeEach, expect, it, vi } from "vitest";
const { invoke, channels } = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (packet: unknown) => void }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_packet: unknown) => {};
    constructor() {
      channels.push(this);
    }
  },
}));
import { createTerminalWindowClient } from "@/features/terminal/terminalWindowClient";
const identity = { windowId: "panel-one", document: "document-secret" };
const lease = { panelId: "terminal:one", windowId: "panel-one", generation: 3 };
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  channels.length = 0;
});
it("uses only the closed document-scoped broker and exact lease, never arbitrary SSH IPC", async () => {
  const client = createTerminalWindowClient(identity);
  await client.bind("one");
  await client.detach(lease);
  await client.write(lease, "YQ==");
  await client.resize(lease, 80, 24);
  await client.unbind(lease.panelId);
  expect(invoke.mock.calls.map((call) => call[0])).toEqual(Array(5).fill("panel_window_terminal"));
  expect(invoke).toHaveBeenNthCalledWith(3, "panel_window_terminal", {
    document: identity.document,
    request: { action: "write", lease, data: "YQ==" },
  });
  expect(invoke.mock.calls.every((call) => !Object.hasOwn(call[1], "windowId"))).toBe(true);
  client.dispose();
  await expect(client.detach(lease)).rejects.toThrow("panel.window.disposed");
  expect(invoke).toHaveBeenCalledTimes(5);
});
it("receives packets before attach resolves and retires only the local listener, not the stream", async () => {
  let finish!: () => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const client = createTerminalWindowClient(identity);
  const receive = vi.fn();
  const pending = client.attach(lease, receive);
  const packet = { sequence: 1, data: "YQ==" };
  channels[0]!.onmessage(packet);
  expect(receive).toHaveBeenCalledWith(packet);
  finish();
  const release = await pending;
  release();
  release();
  channels[0]!.onmessage({ sequence: 2, data: "Yg==" });
  expect(receive).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledOnce();
  client.dispose();
});
it("suppresses late packets/replies after disposal and never sends a stale cleanup detach", async () => {
  let finish!: () => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const client = createTerminalWindowClient(identity);
  const receive = vi.fn();
  const pending = client.attach(lease, receive);
  client.dispose();
  finish();
  await expect(pending).rejects.toThrow("panel.window.disposed");
  channels[0]!.onmessage({ sequence: 1, data: "YQ==" });
  expect(receive).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledOnce();
});
it("retires a failed attachment listener", async () => {
  invoke.mockRejectedValueOnce(new Error("stale panel owner"));
  const client = createTerminalWindowClient(identity);
  const receive = vi.fn();
  await expect(client.attach(lease, receive)).rejects.toThrow("stale panel owner");
  channels[0]!.onmessage({ sequence: 1, data: "YQ==" });
  expect(receive).not.toHaveBeenCalled();
  client.dispose();
});
