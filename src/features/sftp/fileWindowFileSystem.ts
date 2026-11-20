import type { FileSystem } from "@/lib/files/fs";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { createFileWindowClient, FileWindowTarget } from "./fileWindowClient";

type Client = ReturnType<typeof createFileWindowClient>;
/** External editor/system-open effects stay with their explicit owner. The file
 * page does not gain arbitrary text-save or OS-launch IPC from directory access. */
type ExternalEffects = {
  [K in "readText" | "writeText" | "openLocal"]: (
    lease: PanelLease,
    ...args: Parameters<FileSystem[K]>
  ) => ReturnType<FileSystem[K]>;
};
/** Production renderer filesystem adapter. Resolve the current target on EVERY
 * call so staged promotion uses the committed generation without remounting.
 * The owner must supply all external effects; there is no global IPC fallback. */
export function createFileWindowFileSystem(
  client: Client,
  target: () => FileWindowTarget,
  external: ExternalEffects,
): FileSystem {
  const owned = () => {
    const current = target();
    if (current.kind !== "owned") throw new Error("staged file page is read only");
    return current.lease;
  };
  return {
    list: (source, path) => client.list(target(), source, path),
    home: (source) => client.home(target(), source),
    async mkdir(source, path) {
      await client.mkdir(owned(), source, path);
    },
    async createFile(source, path) {
      await client.createFile(owned(), source, path);
    },
    async rename(source, from, to, overwrite = false) {
      await client.rename(owned(), source, from, to, overwrite);
    },
    async remove(source, path, isDir) {
      await client.remove(owned(), source, path, isDir);
    },
    async copy(source, from, to, overwrite = false) {
      await client.copy(owned(), source, from, to, overwrite);
    },
    async transfer(from, fromPath, to, toPath, removeSource, overwrite = false) {
      return client.transfer(owned(), from, fromPath, to, toPath, removeSource, overwrite);
    },
    async readText(...args) {
      return external.readText(owned(), ...args);
    },
    async writeText(...args) {
      await external.writeText(owned(), ...args);
    },
    async openLocal(path) {
      await external.openLocal(owned(), path);
    },
  };
}
