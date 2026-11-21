import { createFileWindowClient } from "@/features/sftp/fileWindowClient";
import { createTerminalWindowClient } from "@/features/terminal/terminalWindowClient";
import type { ForwardingWindowMutation } from "@/features/forwarding/runtime/windowProtocol";
import { createNativePluginViewClient } from "./windowPluginClient";
import type { NativePluginUiPrompt } from "./windowPluginUi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  NativePanelIdentity,
  NativePanelDragRelease,
  PanelLease,
  PanelViewAction,
  PanelActionResult,
  PanelActionJob,
  PanelMoveJob,
  PanelPresentationJob,
  PanelLayoutMetadata,
  NativePanelSnapshot,
  PanelWindowCommand,
} from "./windowProtocol";

/** Scoped to one current document. Never persist its identity or leak it to
 * plugin messages; every mutation still checks the host's lease generation. */
export function createPanelWindowClient(identity: NativePanelIdentity) {
  let disposed = false;
  const terminals = createTerminalWindowClient(identity);
  const files = createFileWindowClient(identity);
  let pluginViews: ReturnType<typeof createNativePluginViewClient> | undefined;
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
  const receiveAction = async <T = unknown>(id: string, signal?: AbortSignal): Promise<T> => {
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
  };
  return {
    windowId: identity.windowId,
    terminals,
    files,
    /** One attachment client per document; never expose its document identity. */
    pluginViews(report: (error: unknown) => void) {
      check();
      return (pluginViews ??= createNativePluginViewClient(identity, { report }));
    },
    control,
    /** Host-only view attachment. A late reply must still be retired even when
     * the display/document was disposed while native admission was pending. */
    async openPreviewHandle(
      target: Extract<PanelWindowCommand, { action: "openPreviewHandle" }>["target"],
      resourceId: string,
      signal?: AbortSignal,
    ) {
      check();
      signal?.throwIfAborted();
      let id: string | undefined;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener("abort", close);
        cleanups.delete(close);
        if (id)
          void invoke("panel_window_control", {
            document: identity.document,
            request: { action: "closePreviewHandle", id },
          }).catch(() => {});
      };
      try {
        id = await invoke<string>("panel_window_control", {
          document: identity.document,
          request: { action: "openPreviewHandle", target, resourceId },
        });
        cleanups.add(close);
        signal?.addEventListener("abort", close, { once: true });
        check();
        signal?.throwIfAborted();
        return Object.freeze({ id, dispose: close });
      } catch (error) {
        close();
        throw error;
      }
    },
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
    /** Metadata invalidations only. Do not forward settings or grant payloads
     * into the provider module, and do not hydrate main-document stores. */
    async subscribeForwardingProvider(changed: () => void) {
      check();
      let active = true;
      const stops: (() => void)[] = [];
      const release = () => {
        if (!active) return;
        active = false;
        cleanups.delete(release);
        for (const stop of stops.splice(0)) stop();
      };
      cleanups.add(release);
      try {
        for (const event of [
          "ui://panel-windows-changed",
          "settings://changed",
          "plugin:security-changed",
          "plugin://state",
        ]) {
          if (!active) break;
          const stop = await listen(event, () => {
            if (active && !disposed) changed();
          });
          if (!active || disposed) stop();
          else stops.push(stop);
        }
      } catch (error) {
        release();
        throw error;
      }
      return release;
    },
    async onPanelFocus(focus: (lease: PanelLease) => void) {
      check();
      let active = true;
      const unlisten = await listen<PanelLease>("ui://panel-window-focus", ({ payload }) => {
        if (!disposed && active && payload?.windowId === identity.windowId) focus(payload);
      });
      if (disposed) {
        unlisten();
        return () => {};
      }
      const release = () => {
        if (!cleanups.delete(release)) return;
        active = false;
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
    async listPluginUi() {
      check();
      const result = await invoke<NativePluginUiPrompt[]>("panel_window_plugin_view", {
        document: identity.document,
        request: { action: "listUi" },
      });
      check();
      return result;
    },
    replyPluginUi(id: string, result: boolean | null, error?: string) {
      // Cleanup-only replies may finish after local disposal. Native validates
      // the exact document, pending id, policy and invocation at delivery.
      return invoke<void>("panel_window_plugin_view", {
        document: identity.document,
        request: { action: "replyUi", id, result, error },
      });
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
      return receiveAction<T>(id, signal);
    },
    receiveAction,

    async forwardingMutation<T = unknown>(
      lease: PanelLease,
      request: ForwardingWindowMutation,
    ): Promise<T> {
      check();
      // Snapshot the target and editable values at submission; later UI edits
      // cannot retarget an already admitted native effect. Native still checks
      // document/lease/consent again at the actual synchronous transaction.
      const payload = structuredClone({ lease, request });
      const result = await invoke<T>("panel_window_forwarding", {
        document: identity.document,
        ...payload,
      });
      check();
      return result;
    },
    async claimPresentations() {
      check();
      return invoke<PanelPresentationJob[]>("panel_window_control", {
        document: identity.document,
        request: { action: "claimPresentations" },
      });
    },
    completePresentation(id: string, metadata: PanelLayoutMetadata) {
      return invoke("panel_window_control", {
        document: identity.document,
        request: { action: "completePresentation", id, metadata },
      });
    },
    failPresentation(id: string) {
      return invoke("panel_window_control", {
        document: identity.document,
        request: { action: "failPresentation", id },
      });
    },
    async claimPanelMoves() {
      check();
      // Preserve a late claim so disposal can explicitly release it.
      return invoke<PanelMoveJob[]>("panel_window_control", {
        document: identity.document,
        request: { action: "claimPanelMoves" },
      });
    },
    failPanelMove(id: string) {
      // Cleanup-only after local disposal; native still checks exact source.
      return invoke("panel_window_control", {
        document: identity.document,
        request: { action: "failPanelMove", id },
      });
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
      terminals.dispose();
      files.dispose();
      disposed = true;
      pluginViews?.dispose();
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    },
  };
}
export type PanelWindowClient = ReturnType<typeof createPanelWindowClient>;
export async function initializePanelWindow() {
  return createPanelWindowClient(await invoke<NativePanelIdentity>("panel_window_initialize"));
}
