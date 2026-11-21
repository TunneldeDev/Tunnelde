import { expect, it, vi } from "vitest";
const global = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: global.invoke }));
import { createFileSystem, type FileSystemBackend } from "@/lib/files/fs";
const local = { kind: "local" } as const;
const remote = { kind: "remote", sessionId: "original-session" } as const;
function fixture() {
  const names = [
    "localList",
    "sftpList",
    "localHome",
    "localMkdir",
    "sftpMkdir",
    "localCreateFile",
    "sftpCreateFile",
    "localRename",
    "sftpRename",
    "localDelete",
    "sftpDelete",
    "localCopy",
    "sftpCopy",
    "fsTransfer",
    "localReadText",
    "sftpReadText",
    "localWriteText",
    "sftpWriteText",
    "openLocalPath",
  ] as const;
  const backend = Object.fromEntries(
    names.map((name) => [name, vi.fn().mockResolvedValue(null)]),
  ) as unknown as FileSystemBackend;
  return { backend, fs: createFileSystem(backend) };
}
it("routes both filesystems through only the supplied backend with exact source identity", async () => {
  const { backend, fs } = fixture();
  await fs.list(local);
  await fs.list(remote, "/srv");
  await fs.home(local);
  expect(await fs.home(remote)).toBe(".");
  await fs.mkdir(remote, "/srv/new");
  await fs.createFile(local, "/tmp/new");
  await fs.rename(remote, "/srv/a", "/srv/b", true);
  await fs.remove(local, "/tmp/new", false);
  await fs.copy(remote, "/srv/a", "/srv/c");
  await fs.transfer(remote, "/srv/a", local, "/tmp/a", true, true);
  await fs.transfer(local, "/tmp/b", remote, "/srv/b", false);
  await fs.openLocal("/tmp/a");
  expect(backend.localList).toHaveBeenCalledWith(null);
  expect(backend.sftpList).toHaveBeenCalledWith("original-session", "/srv");
  expect(backend.localHome).toHaveBeenCalledOnce();
  expect(backend.sftpMkdir).toHaveBeenCalledWith("original-session", "/srv/new");
  expect(backend.localCreateFile).toHaveBeenCalledWith("/tmp/new");
  expect(backend.sftpRename).toHaveBeenCalledWith("original-session", "/srv/a", "/srv/b", true);
  expect(backend.localDelete).toHaveBeenCalledWith("/tmp/new", false);
  expect(backend.sftpCopy).toHaveBeenCalledWith("original-session", "/srv/a", "/srv/c", false);
  expect(backend.fsTransfer).toHaveBeenCalledWith(
    "original-session",
    "/srv/a",
    null,
    "/tmp/a",
    true,
    true,
  );
  expect(backend.fsTransfer).toHaveBeenCalledWith(
    null,
    "/tmp/b",
    "original-session",
    "/srv/b",
    false,
    false,
  );
  expect(backend.openLocalPath).toHaveBeenCalledWith("/tmp/a");
  expect(global.invoke).not.toHaveBeenCalled();
});
it("preserves text encoding, baseline and BOM arguments without global IPC", async () => {
  const { backend, fs } = fixture();
  await fs.readText(remote, "/srv/a", "gb18030");
  await fs.writeText(remote, "/srv/a", "new", "baseline", "utf-8", false, "gb18030", true);
  await fs.readText(local, "/tmp/a", "utf-16le");
  await fs.writeText(local, "/tmp/a", "new", "baseline", "utf-16le", true, "utf-8", false);
  expect(backend.sftpReadText).toHaveBeenCalledWith("original-session", "/srv/a", "gb18030");
  expect(backend.sftpWriteText).toHaveBeenCalledWith(
    "original-session",
    "/srv/a",
    "new",
    "baseline",
    "utf-8",
    false,
    "gb18030",
    true,
  );
  expect(backend.localReadText).toHaveBeenCalledWith("/tmp/a", "utf-16le");
  expect(backend.localWriteText).toHaveBeenCalledWith(
    "/tmp/a",
    "new",
    "baseline",
    "utf-16le",
    true,
    "utf-8",
    false,
  );
  expect(global.invoke).not.toHaveBeenCalled();
});
it("does not retry a rejected scoped effect through the main IPC backend", async () => {
  const { backend, fs } = fixture();
  vi.mocked(backend.sftpRename).mockRejectedValue(new Error("panel.window.staleOwner"));
  await expect(fs.rename(remote, "/srv/a", "/srv/b")).rejects.toThrow("staleOwner");
  expect(backend.sftpRename).toHaveBeenCalledOnce();
  expect(global.invoke).not.toHaveBeenCalled();
});
