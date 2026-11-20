import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { createFileWindowClient, type FileWindowTarget } from "@/features/sftp/fileWindowClient";
import { createFileWindowFileSystem } from "@/features/sftp/fileWindowFileSystem";
const remote = { kind: "remote" as const, sessionId: "remote-one" };
const local = { kind: "local" as const };
const lease = { panelId: "files:one", windowId: "satellite", generation: 2 };
beforeEach(() => invoke.mockReset().mockResolvedValue(null));
function fixture() {
  const client = createFileWindowClient({ windowId: "satellite", document: "doc" });
  let target: FileWindowTarget = { kind: "staged", id: "offer" };
  const external = { readText: vi.fn(), writeText: vi.fn(), openLocal: vi.fn() };
  const fs = createFileWindowFileSystem(client, () => target, external);
  return {
    client,
    external,
    fs,
    promote: () => {
      target = { kind: "owned", lease };
    },
  };
}
it("allows exact staged reads but rejects every mutation/external effect before dispatch", async () => {
  const { fs, external } = fixture();
  await fs.list(remote, "/read");
  expect(invoke.mock.calls[0]![1].request.target).toEqual({ kind: "staged", id: "offer" });
  for (const action of [
    () => fs.mkdir(local, "/new"),
    () => fs.createFile(local, "/new"),
    () => fs.rename(remote, "/old", "/new"),
    () => fs.copy(remote, "/old", "/new"),
    () => fs.remove(remote, "/old", false),
    () => fs.transfer(remote, "/old", local, "/new", false),
    () => fs.readText(remote, "/old"),
    () => fs.writeText(remote, "/old", "new", "old", "utf-8", false),
    () => fs.openLocal("/old"),
  ])
    await expect(action()).rejects.toThrow("staged file page is read only");
  expect(invoke).toHaveBeenCalledOnce();
  for (const callback of Object.values(external)) expect(callback).not.toHaveBeenCalled();
});
it("uses the committed lease after promotion without recreating its filesystem or client", async () => {
  const { fs, promote } = fixture();
  await fs.home(remote);
  promote();
  invoke.mockResolvedValueOnce("transfer-one");
  expect(await fs.transfer(remote, "/source", local, "/target", true, true)).toBe("transfer-one");
  expect(invoke.mock.calls[1]![1].request).toEqual({
    action: "execute",
    target: { kind: "owned", lease },
    operation: {
      operation: "transfer",
      fromSource: remote,
      fromPath: "/source",
      toSource: local,
      toPath: "/target",
      removeSource: true,
      overwrite: true,
    },
  });
  await fs.copy(remote, "/source", "/copy");
  expect(invoke.mock.calls[2]![1].request.operation).toEqual({
    operation: "copy",
    source: remote,
    from: "/source",
    to: "/copy",
    overwrite: false,
  });
});
it("uses only explicitly supplied external owners and never retries a denied transfer", async () => {
  const { fs, external, promote } = fixture();
  promote();
  await fs.readText(remote, "/file", "gb18030");
  expect(external.readText).toHaveBeenCalledWith(lease, remote, "/file", "gb18030");
  await fs.openLocal("/file");
  expect(external.openLocal).toHaveBeenCalledWith(lease, "/file");
  invoke.mockRejectedValueOnce(new Error("retired-file-origin"));
  await expect(fs.transfer(local, "/file", remote, "/file", false)).rejects.toThrow(
    "retired-file-origin",
  );
  expect(invoke).toHaveBeenCalledOnce();
});
