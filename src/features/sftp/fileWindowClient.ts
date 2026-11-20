import { invoke } from "@tauri-apps/api/core";
import type { FsSource, Listing } from "@/lib/api/types";
import type { NativePanelIdentity, PanelLease } from "@/lib/panels/windowProtocol";
export type FileWindowTarget =
  { kind: "owned"; lease: PanelLease } | { kind: "staged"; id: string };
export type FileWindowOperation =
  | { operation: "list"; source: FsSource; path: string | null }
  | { operation: "home"; source: FsSource }
  | { operation: "mkdir" | "createFile"; source: FsSource; path: string }
  | { operation: "remove"; source: FsSource; path: string; isDir: boolean }
  | { operation: "rename"; source: FsSource; from: string; to: string; overwrite: boolean };
type Request =
  | { action: "bind"; panelId: string; sources: FsSource[]; allowMove: boolean }
  | { action: "unbind"; panelId: string }
  | { action: "execute"; target: FileWindowTarget; operation: FileWindowOperation };
/** Private file-page client. Native derives the actual caller, validates source
 * membership, and retains effect authority through worker settlement. No SSH
 * bootstrap, main-store hydration, plugin Bus, or global IPC fallback. */
export function createFileWindowClient(identity: NativePanelIdentity) {
  let disposed = false;
  const check = () => {
    if (disposed) throw new Error("panel.window.disposed");
  };
  async function request<T>(request: Request): Promise<T> {
    check();
    const result = await invoke<T>("panel_window_files", { document: identity.document, request });
    check();
    return result;
  }
  const execute = <T>(target: FileWindowTarget, operation: FileWindowOperation) =>
    request<T>({ action: "execute", target, operation });
  const owned = (lease: PanelLease): FileWindowTarget => ({ kind: "owned", lease });
  return {
    bind: (panelId: string, sources: FsSource[], allowMove: boolean) =>
      request<PanelLease>({ action: "bind", panelId, sources, allowMove }),
    unbind: (panelId: string) => request<void>({ action: "unbind", panelId }),
    list: (target: FileWindowTarget, source: FsSource, path?: string | null) =>
      execute<Listing>(target, { operation: "list", source, path: path ?? null }),
    home: (target: FileWindowTarget, source: FsSource) =>
      execute<string>(target, { operation: "home", source }),
    mkdir: (lease: PanelLease, source: FsSource, path: string) =>
      execute<void>(owned(lease), { operation: "mkdir", source, path }),
    createFile: (lease: PanelLease, source: FsSource, path: string) =>
      execute<void>(owned(lease), { operation: "createFile", source, path }),
    remove: (lease: PanelLease, source: FsSource, path: string, isDir: boolean) =>
      execute<void>(owned(lease), { operation: "remove", source, path, isDir }),
    rename: (lease: PanelLease, source: FsSource, from: string, to: string, overwrite = false) =>
      execute<void>(owned(lease), { operation: "rename", source, from, to, overwrite }),
    dispose() {
      disposed = true;
    },
  };
}
