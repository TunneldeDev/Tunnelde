import {
  NodeRuntimeSectionView,
  type NodeRuntimeServices,
  type NodeRuntimeData,
} from "./components/NodeRuntimeSectionView";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import { Dialog } from "@/components/ui/overlay/Dialog";
import { api, events, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useDialogs } from "@/store/dialogs";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { ActivationDecision } from "@/lib/plugins/activation/decision";

// The operation outlives settings navigation, keeping cancellation available when
// the user returns and preventing duplicate installations across both surfaces.
const useRuntime = create<Omit<NodeRuntimeData, "nativeAvailable">>(() => ({
  info: null,
  busy: null,
  error: null,
  progress: null,
  cancelling: false,
}));

async function check() {
  if (useRuntime.getState().busy) return;
  useRuntime.setState({ busy: "checking", error: null });
  try {
    useRuntime.setState({ info: await api.nodeDetect() });
  } catch (error) {
    useRuntime.setState({ error: translateError(error) });
  } finally {
    useRuntime.setState({ busy: null });
  }
}

async function choose(automatic = false) {
  if (useRuntime.getState().busy) return;
  useRuntime.setState({ busy: "choosing", error: null });
  try {
    const path = automatic ? null : await api.nodePick();
    if (!automatic && path === null) return;
    useRuntime.setState({ info: await api.nodeSetPath(path) });
  } catch (error) {
    useRuntime.setState({ error: translateError(error) });
  } finally {
    useRuntime.setState({ busy: null });
  }
}

async function allowSystem(allowed: boolean) {
  if (useRuntime.getState().busy) return;
  useRuntime.setState({ busy: "checking", error: null });
  try {
    useRuntime.setState({ info: await api.nodeAllowSystem(allowed) });
  } catch (error) {
    useRuntime.setState({ error: translateError(error) });
  } finally {
    useRuntime.setState({ busy: null });
  }
}

async function install() {
  if (useRuntime.getState().busy) return;
  const taskId = `node-${crypto.randomUUID()}`;
  useRuntime.setState({
    busy: "installing",
    error: null,
    progress: { taskId, phase: "connecting", received: 0, total: null },
    cancelling: false,
  });
  let unlisten: (() => void) | undefined;
  try {
    // Await event registration before invoking: even a cached/local download may
    // otherwise emit its first events before the listener is ready.
    unlisten = await events.onPluginDownload((progress) => {
      if (progress.taskId === taskId) useRuntime.setState({ progress });
    });
    if (useRuntime.getState().cancelling) return;
    const info = await api.nodeInstall(taskId);
    // Show the resolver's active runtime after the private installation completes.
    useRuntime.setState({ info: await api.nodeDetect().catch(() => info) });
  } catch (error) {
    useRuntime.setState({ error: translateError(error) });
  } finally {
    unlisten?.();
    useRuntime.setState({ busy: null, progress: null, cancelling: false });
  }
}

async function cancel() {
  const { progress, cancelling } = useRuntime.getState();
  if (!progress || cancelling) return;
  useRuntime.setState({ cancelling: true });
  try {
    // If listener registration is pending, install() observes the flag before
    // starting the backend task.
    await api.downloadCancel(progress.taskId);
  } catch (error) {
    useRuntime.setState({ error: translateError(error), cancelling: false });
  }
}

export const mainNodeRuntimeServices: NodeRuntimeServices = {
  useData() {
    return { ...useRuntime(), nativeAvailable: isTauri() };
  },
  useBusyGuard: useBackgroundGuard,
  load: async () => {
    if (isTauri() && !useRuntime.getState().info) await check();
  },
  check,
  choose,
  allowSystem,
  install,
  cancel,
  confirm: (options) => useDialogs.getState().confirm(options),
};
export function NodeRuntimeSection(props: { onReady?: () => void; embedded?: boolean }) {
  return <NodeRuntimeSectionView {...props} services={mainNodeRuntimeServices} />;
}

const useGate = create<{ request: ActivationDecision | null }>(() => ({ request: null }));
export const useNodeRuntimeGateOpen = () => useGate((state) => state.request !== null);
let gate: ActivationDecision | null = null;

/** First-use setup is shared by concurrent plugin starts and view requests. */
export function ensureNodeRuntime(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (usePluginSecurity.getState().state.restricted) return Promise.resolve(false);
  if (gate) return gate.wait(signal);
  const request = new ActivationDecision(() => {
    if (gate !== request) return;
    gate = null;
    useGate.setState({ request: null });
  });
  gate = request;
  const result = request.wait(signal);
  void (async () => {
    try {
      const info = await api.nodeDetect();
      if (!request.active) return;
      if (usePluginSecurity.getState().state.restricted) {
        request.finish(false);
        return;
      }
      useRuntime.setState({ info });
      if (info.compatible) {
        request.finish(true);
        return;
      }
    } catch (error) {
      if (!request.active) return;
      useRuntime.setState({ error: translateError(error) });
    }
    if (!request.active) return;
    if (usePluginSecurity.getState().state.restricted) {
      request.finish(false);
      return;
    }
    useGate.setState({ request });
  })();
  return result;
}

export function NodeRuntimeGate() {
  const { t } = useTranslation();
  const request = useGate((state) => state.request);
  const restricted = usePluginSecurity((state) => state.state.restricted);
  useEffect(() => {
    if (restricted) gate?.finish(false);
  }, [restricted]);
  return (
    <Dialog
      open={request !== null}
      title={t("plugins.node.title")}
      closeLabel={t("common.close")}
      onClose={() => request?.finish(false)}
      width={560}
    >
      {request ? <NodeRuntimeSection onReady={() => request.finish(true)} embedded /> : null}
    </Dialog>
  );
}
