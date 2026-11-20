import { PanelStateLossRequired, type PanelCaptureOptions } from "@/lib/panels/stateLoss";
import { useLayoutEffect, useRef, useState } from "react";
import { usePanelViewController } from "@/lib/panels/viewState";
import { awaitPanelWork } from "@/lib/panels/viewCapture";
import type { MountedFrontendView } from "./frontend";

const KEY = "plugin.factory";
function binding(pluginId: string, viewId: string) {
  const loss = Object.freeze({ pluginId, viewId });
  let view: MountedFrontendView | null = null,
    disposed = false,
    resolve!: () => void,
    reject!: (error: unknown) => void;
  const ready = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // A view may be removed before any native stage/capture starts waiting.
  void ready.catch(() => {});
  return {
    rendered(mounted: MountedFrontendView) {
      if (disposed) return;
      view = mounted;
      resolve();
    },
    fail(error: unknown) {
      reject(error);
    },
    ready: (signal: AbortSignal) => awaitPanelWork(ready, signal),
    async capture(signal: AbortSignal, options?: PanelCaptureOptions) {
      await awaitPanelWork(ready, signal);
      if (disposed || signal.aborted || !view) throw new Error("panel.window.cancelled");
      if (!view.stateful) {
        if (!options?.consentedStateLoss?.has(loss)) throw new PanelStateLossRequired([loss]);
        return { version: 1, pluginId, viewId, reset: true };
      }
      const state = await view.captureState();
      if (disposed || signal.aborted) throw new Error("panel.window.cancelled");
      return { version: 1, pluginId, viewId, state };
    },
    dispose() {
      disposed = true;
      view = null;
      reject(new Error("panel.window.cancelled"));
    },
  };
}
/** One binding per committed effect. No activation secret enters a capsule. */
export function useFactoryPanelState(pluginId: string, viewId: string, parent?: AbortSignal) {
  const controller = usePanelViewController();
  const [identity] = useState(() => ({ pluginId, viewId, controller }));
  if (
    identity.pluginId !== pluginId ||
    identity.viewId !== viewId ||
    identity.controller !== controller
  )
    throw new Error("panel.viewState.identityChanged");
  const [initial] = useState(() => {
    const incoming = controller?.read(
      KEY,
      (value): value is Record<string, unknown> => value !== undefined,
    );
    if (incoming === undefined) return undefined;
    if (
      !incoming ||
      typeof incoming !== "object" ||
      Array.isArray(incoming) ||
      incoming.version !== 1 ||
      incoming.pluginId !== pluginId ||
      incoming.viewId !== viewId ||
      (incoming.reset === true
        ? Object.keys(incoming).some(
            (key) => !["version", "pluginId", "viewId", "reset"].includes(key),
          )
        : !Object.prototype.hasOwnProperty.call(incoming, "state") ||
          Object.keys(incoming).some(
            (key) => !["version", "pluginId", "viewId", "state"].includes(key),
          ))
    )
      throw new Error("panel.viewState.invalid");
    return incoming.reset === true ? undefined : { value: incoming.state };
  });
  const current = useRef<ReturnType<typeof binding> | null>(null);
  useLayoutEffect(() => {
    const owner = binding(pluginId, viewId);
    current.current = owner;
    const unregister = controller?.registerAsync(KEY, owner.capture, owner.ready);
    return () => {
      unregister?.();
      owner.dispose();
      if (current.current === owner) current.current = null;
    };
  }, [controller, pluginId, viewId, parent]);
  return { initial, current };
}
