import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  NativePanelIdentity,
  PanelLease,
  NativePanelSnapshot,
  PanelWindowCommand,
} from "./windowProtocol";

/** Scoped to one current document. Never persist its identity or leak it to
 * plugin messages; every mutation still checks the host's lease generation. */
export function createPanelWindowClient(identity: NativePanelIdentity) {
  let disposed = false;
  const cleanups = new Set<() => void>();
  const check = () => {
    if (disposed) throw new Error("panel.window.disposed");
  };
  const control = async <T = unknown>(request: PanelWindowCommand): Promise<T> => {
    check();
    const result = await invoke<T>("panel_window_control", {
      document: identity.document,
      request,
    });
    check();
    return result;
  };
  return {
    windowId: identity.windowId,
    control,
    snapshot: () => control<NativePanelSnapshot>({ action: "snapshot" }),
    async subscribe(changed: () => void) {
      check();
      const unlisten = await listen("ui://panel-windows-changed", () => {
        if (!disposed) changed();
      });
      if (disposed) {
        unlisten();
        return () => {};
      }
      const release = () => {
        if (!cleanups.delete(release)) return;
        unlisten();
      };
      cleanups.add(release);
      return release;
    },
    async onClose(close: () => void) {
      check();
      const unlisten = await listen("ui://panel-window-close", () => {
        if (!disposed) close();
      });
      if (disposed) {
        unlisten();
        return () => {};
      }
      const release = () => {
        if (!cleanups.delete(release)) return;
        unlisten();
      };
      cleanups.add(release);
      return release;
    },
    async create() {
      check();
      const id = await invoke<string>("panel_window_create", { document: identity.document });
      check();
      return id;
    },
    async show() {
      check();
      await invoke("panel_window_show", { document: identity.document });
      check();
    },
    async destroy(target: string) {
      check();
      await invoke("panel_window_destroy", { document: identity.document, target });
    },
    async focus(panelId: string) {
      check();
      await invoke("panel_window_focus", { document: identity.document, panelId });
      check();
    },
    async disconnect(lease: PanelLease, sessionId: string) {
      check();
      await invoke("panel_window_disconnect", { document: identity.document, lease, sessionId });
      check();
    },
    async dropTarget() {
      check();
      const target = await invoke<string | null>("panel_window_drop_target", {
        document: identity.document,
      });
      check();
      return target;
    },
    dispose() {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    },
  };
}
export type PanelWindowClient = ReturnType<typeof createPanelWindowClient>;
export async function initializePanelWindow() {
  return createPanelWindowClient(await invoke<NativePanelIdentity>("panel_window_initialize"));
}
