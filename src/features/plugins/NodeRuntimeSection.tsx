import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api, events, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { NodeRuntimeInfo } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { ActivationDecision } from "@/lib/plugins/activation/decision";

interface Progress {
  taskId: string;
  phase: string;
  received: number;
  total: number | null;
}

interface RuntimeState {
  info: NodeRuntimeInfo | null;
  busy: "checking" | "choosing" | "installing" | null;
  error: string | null;
  progress: Progress | null;
  cancelling: boolean;
}

// The operation outlives settings navigation, keeping cancellation available when
// the user returns and preventing duplicate installations across both surfaces.
const useRuntime = create<RuntimeState>(() => ({
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

export function NodeRuntimeSection({
  onReady,
  embedded = false,
}: {
  onReady?: () => void;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const { info, busy, error, progress, cancelling } = useRuntime();
  useEffect(() => {
    if (isTauri() && !useRuntime.getState().info) void check();
  }, []);
  useEffect(() => {
    if (info?.compatible && !busy) onReady?.();
  }, [info, busy, onReady]);
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : undefined;
  const phases = {
    connecting: "plugins.node.phase.connecting",
    metadata: "plugins.node.phase.metadata",
    checksum: "plugins.node.phase.checksum",
    downloading: "plugins.node.phase.downloading",
    downloaded: "plugins.node.phase.downloaded",
    verifying: "plugins.node.phase.verifying",
    extracting: "plugins.node.phase.extracting",
    activating: "plugins.node.phase.activating",
    complete: "plugins.node.phase.complete",
  } as const;
  const sources = {
    explicit: "plugins.node.sources.explicit",
    environment: "plugins.node.sources.environment",
    path: "plugins.node.sources.path",
    registry: "plugins.node.sources.registry",
    shell: "plugins.node.sources.shell",
    managed: "plugins.node.sources.managed",
  } as const;
  const phase = phases[progress?.phase as keyof typeof phases] ?? phases.connecting;
  const source = sources[info?.source as keyof typeof sources];
  const displayPath = info?.path?.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
  return (
    <section className="settings-subsection" aria-label={t("plugins.node.title")}>
      {!embedded ? <h3 className="settings-subtitle">{t("plugins.node.title")}</h3> : null}
      <p className="settings-hint">{t("plugins.node.description")}</p>
      <p role="status" aria-live="polite">
        {t(
          busy === "checking"
            ? "plugins.node.checking"
            : info?.compatible
              ? "plugins.node.ready"
              : "plugins.node.unavailable",
        )}
        {info?.version ? ` · Node ${info.version}` : ""}
        {source ? ` · ${t(source)}` : ""}
      </p>
      {info?.path ? (
        <p className="plugin-install-path" title={displayPath} style={{ overflowWrap: "anywhere" }}>
          {displayPath}
        </p>
      ) : null}
      {info?.issue && !error ? (
        <p className="settings-hint">
          {translateError({ code: "validation", message: info.issue })}
        </p>
      ) : null}
      <div className="settings-actions">
        {info?.issue === "node.consentRequired" && info.path ? (
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() =>
              useDialogs.getState().confirm({
                title: t("plugins.node.useDetectedTitle"),
                body: t("plugins.node.useDetectedBody", { path: displayPath }),
                confirmLabel: t("plugins.node.useDetected"),
                onConfirm: () => allowSystem(true),
              })
            }
          >
            {t("plugins.node.useDetected")}
          </Button>
        ) : null}
        {info?.source &&
        ["environment", "path", "registry", "shell"].includes(info.source) &&
        info.issue !== "node.consentRequired" ? (
          <Button size="sm" disabled={!!busy} onClick={() => void allowSystem(false)}>
            {t("plugins.node.revokeSystem")}
          </Button>
        ) : null}
        <Button size="sm" disabled={!!busy} onClick={() => void check()}>
          {t("plugins.node.recheck")}
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => void choose()}>
          {t("plugins.node.choose")}
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => void choose(true)}>
          {t("plugins.node.automatic")}
        </Button>
        <Button
          size="sm"
          disabled={!!busy || !isTauri()}
          onClick={() =>
            useDialogs.getState().confirm({
              title: t("plugins.node.installTitle"),
              body: t("plugins.node.installBody"),
              confirmLabel: t("plugins.node.install"),
              onConfirm: () => {
                void install();
              },
            })
          }
        >
          {t("plugins.node.install")}
        </Button>
      </div>
      {progress ? (
        <div aria-busy="true">
          <p role="status">
            {t(cancelling ? "plugins.node.cancelling" : phase)}
            {percent === undefined ? "" : ` · ${percent}%`}
          </p>
          <progress aria-label={t(phase)} value={percent} max={100} style={{ width: "100%" }} />
          <Button size="sm" disabled={cancelling} onClick={() => void cancel()}>
            {t("plugins.node.cancel")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
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
