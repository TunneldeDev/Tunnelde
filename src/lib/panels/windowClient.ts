import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  NativePanelIdentity,
  NativePanelDragRelease,
  PanelLease,
  PanelViewAction,
  PanelActionResult,
  PanelActionJob,
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
    async create(lease?: PanelLease) {
      check();
      const id = await invoke<string>("panel_window_create", {
        document: identity.document,
        lease,
      });
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
    async action<T = unknown>(
      lease: PanelLease,
      request: PanelViewAction,
      signal?: AbortSignal,
    ): Promise<T> {
      check();
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      // Keep the returned request id even if dispose wins this IPC reply, so an
      // unclaimed job cannot execute later merely because its view disappeared.
      const id = await invoke<string>("panel_window_control", {
        document: identity.document,
        request: { action: "requestAction", lease, request },
      });
      let completed = false;
      try {
        for (;;) {
          check();
          if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
          const result = await control<PanelActionResult | null>({ action: "actionResult", id });
          if (result) {
            completed = true;
            if (result.status === "failed") throw new Error(result.message);
            return result.value as T;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        if (!completed)
          await invoke("panel_window_control", {
            document: identity.document,
            request: { action: "cancelAction", id },
          }).catch(() => {});
      }
    },
    // Unlike ordinary reads, keep late claim replies: native has admitted these
    // jobs and the executor must finalize them even if local disposal won the IPC.
    async claimActions() {
      check();
      return invoke<PanelActionJob[]>("panel_window_control", {
        document: identity.document,
        request: { action: "claimActions" },
      });
    },
    // Finalization is the only operation permitted after local disposal. It
    // cannot start work or change its payload, and native still checks the exact
    // coordinator document/job identity. Running singleton work must release its
    // handoff fence even after its original component/lifecycle has gone away.
    finalizeAction(id: string, result: PanelActionResult) {
      return invoke("panel_window_control", {
        document: identity.document,
        request: { action: "completeAction", id, result },
      });
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
    async releaseDrag(token: string) {
      check();
      const result = await invoke<NativePanelDragRelease>("panel_window_release_drag", {
        document: identity.document,
        token,
      });
      check();
      return result;
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
