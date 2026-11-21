import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { translateError } from "@/lib/api/errors";
import type { NodeRuntimeInfo } from "@/lib/api/types";
import type { ConfirmOptions } from "@/store/dialogs";
export interface NodeRuntimeProgress {
  taskId: string;
  phase: string;
  received: number;
  total: number | null;
}

export interface NodeRuntimeData {
  info: NodeRuntimeInfo | null;
  busy: "checking" | "choosing" | "installing" | null;
  error: string | null;
  progress: NodeRuntimeProgress | null;
  cancelling: boolean;
  nativeAvailable: boolean;
}

export interface NodeRuntimeServices {
  useData(): NodeRuntimeData;
  useBusyGuard(busy: boolean): void;
  load(): Promise<void>;
  check(): Promise<void>;
  choose(automatic?: boolean): Promise<void>;
  allowSystem(allowed: boolean): Promise<void>;
  install(): Promise<void>;
  cancel(): Promise<void>;
  confirm(options: ConfirmOptions): void;
}
export function NodeRuntimeSectionView({
  onReady,
  embedded = false,
  services,
}: {
  onReady?: () => void;
  embedded?: boolean;
  services: NodeRuntimeServices;
}) {
  const { t } = useTranslation();
  const { info, busy, error, progress, cancelling, nativeAvailable } = services.useData();
  const { check, choose, allowSystem, install, cancel, load, useBusyGuard } = services;
  useBusyGuard(!!busy);
  useEffect(() => {
    void load();
  }, [load]);
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
              services.confirm({
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
          disabled={!!busy || !nativeAvailable}
          onClick={() =>
            services.confirm({
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
