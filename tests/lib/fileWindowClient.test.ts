import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { createFileWindowClient } from "@/features/sftp/fileWindowClient";
const identity = { windowId: "panel-one", document: "document-secret" };
const lease = { panelId: "files:one", windowId: "panel-one", generation: 3 };
const source = { kind: "remote" as const, sessionId: "session-one" };
beforeEach(() => invoke.mockReset().mockResolvedValue(null));
it("uses only the closed document-scoped broker and exact owned resource for effects", async () => {
  const client = createFileWindowClient(identity);
  await client.bind(lease.panelId, [source], true);
  await client.mkdir(lease, source, "/new");
  await client.createFile(lease, source, "/new/file");
  await client.rename(lease, source, "/new/file", "/new/renamed");
  await client.remove(lease, source, "/new/renamed", false);
  await client.unbind(lease.panelId);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(
    Array(6).fill("panel_window_files"),
  );
  expect(invoke).toHaveBeenNthCalledWith(4, "panel_window_files", {
    document: identity.document,
    request: {
      action: "execute",
      target: { kind: "owned", lease },
      operation: {
        operation: "rename",
        source,
        from: "/new/file",
        to: "/new/renamed",
        overwrite: false,
      },
    },
  });
  for (const [, args] of invoke.mock.calls)
    expect(Object.keys(args)).toEqual(["document", "request"]);
  client.dispose();
});
it("preserves exact staged read target without upgrading it to an owned lease", async () => {
  const client = createFileWindowClient(identity);
  const target = { kind: "staged" as const, id: "offer-one" };
  const listing = { path: "/home", entries: [] };
  invoke.mockResolvedValueOnce(listing).mockResolvedValueOnce(".");
  expect(await client.list(target, source)).toBe(listing);
  expect(await client.home(target, source)).toBe(".");
  expect(invoke).toHaveBeenNthCalledWith(1, "panel_window_files", {
    document: identity.document,
    request: { action: "execute", target, operation: { operation: "list", source, path: null } },
  });
  client.dispose();
});
it("does not retry a denied effect or fall back to unscoped filesystem commands", async () => {
  invoke.mockRejectedValueOnce(new Error("stale file page resource"));
  const client = createFileWindowClient(identity);
  await expect(client.createFile(lease, source, "/new")).rejects.toThrow(
    "stale file page resource",
  );
  expect(invoke).toHaveBeenCalledOnce();
  client.dispose();
});
it("suppresses a late read after disposal and does not issue stale unbind or cleanup calls", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = createFileWindowClient(identity);
  const pending = client.list({ kind: "owned", lease }, source, "/old");
  client.dispose();
  client.dispose();
  finish({ path: "/old", entries: [] });
  await expect(pending).rejects.toThrow("panel.window.disposed");
  await expect(client.unbind(lease.panelId)).rejects.toThrow("panel.window.disposed");
  await expect(client.mkdir(lease, source, "/new")).rejects.toThrow("panel.window.disposed");
  expect(invoke).toHaveBeenCalledOnce();
});
it("binds copy and cross-source transfer to the exact lease without downgrading sources", async () => {
  const client = createFileWindowClient(identity);
  const local = { kind: "local" as const };
  invoke.mockResolvedValueOnce(null).mockResolvedValueOnce("transfer-id");
  await client.copy(lease, source, "/source", "/copy", true);
  expect(await client.transfer(lease, source, "/source", local, "/download", false)).toBe(
    "transfer-id",
  );
  expect(invoke).toHaveBeenNthCalledWith(2, "panel_window_files", {
    document: identity.document,
    request: {
      action: "execute",
      target: { kind: "owned", lease },
      operation: {
        operation: "transfer",
        fromSource: source,
        fromPath: "/source",
        toSource: local,
        toPath: "/download",
        removeSource: false,
        overwrite: false,
      },
    },
  });
  expect(invoke).toHaveBeenCalledTimes(2);
  client.dispose();
});
