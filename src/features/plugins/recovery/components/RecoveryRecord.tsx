import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type {
  RecoveryAction,
  RecoveryEntry,
  RecoveryObservation,
} from "@/lib/runners/recovery/contracts";

export function RecoveryRecord({
  entry,
  observation,
  pending,
  onAction,
}: {
  entry: RecoveryEntry;
  observation?: RecoveryObservation;
  pending: boolean;
  onAction: (action: RecoveryAction) => void;
}) {
  const { t, i18n } = useTranslation();
  const deployment = entry.runnerId === "deployment";
  const directoryName = entry.directory
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1);
  const status = entry.stopPending
    ? "stopPending"
    : (entry.terminalStatus ?? (entry.launchUncertain ? "uncertain" : "unknown"));
  return (
    <article className="runner-recovery__record">
      <details>
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          <span className="runner-recovery__identity">
            <strong>{deployment ? t("runnerRecovery.deployment") : entry.runnerId}</strong>
            <small title={deployment ? entry.directory : undefined}>
              {entry.address ?? entry.hostId}
              {deployment && directoryName ? ` · ${directoryName}` : ""}
            </small>
          </span>
          <span className="runner-recovery__badges">
            <span className={`runner-recovery__badge is-${entry.connection}`}>
              {t(`runnerRecovery.connection.${entry.connection}`)}
            </span>
            {deployment ? (
              <span className={`runner-recovery__badge is-${entry.deploymentState ?? "ready"}`}>
                {t(`runnerRecovery.deploymentStatus.${entry.deploymentState ?? "ready"}`)}
              </span>
            ) : (
              <span className={`runner-recovery__badge is-${status}`}>
                {t(`runnerRecovery.status.${status}`)}
              </span>
            )}
          </span>
        </summary>
        <div className="runner-recovery__detail">
          <dl>
            <dt>{t("runnerRecovery.directory")}</dt>
            <dd>{entry.directory}</dd>
            <dt>{t("runnerRecovery.host")}</dt>
            <dd>{entry.hostId}</dd>
            <dt>{t("runnerRecovery.serverKey")}</dt>
            <dd>{entry.serverKey ?? t("runnerRecovery.unreviewed")}</dd>
          </dl>
          {!deployment && entry.configurationState && (
            <p className="settings-hint">
              <strong>{t(`runnerRecovery.configurationStatus.${entry.configurationState}`)}</strong>
              {" · "}
              {t(
                entry.configurationState === "creating" || entry.configurationState === "writing"
                  ? "runnerRecovery.incompleteConfigurationHint"
                  : "runnerRecovery.configurationHint",
              )}
            </p>
          )}
          {deployment && entry.deploymentState && entry.deploymentState !== "ready" && (
            <p className="settings-hint">
              {t(
                entry.deploymentState === "reserved"
                  ? "runnerRecovery.reservedDeploymentHint"
                  : "runnerRecovery.incompleteDeploymentHint",
              )}
            </p>
          )}
          {entry.controlChanged && (
            <p className="settings-hint">{t("runnerRecovery.packageChanged")}</p>
          )}
          {entry.stopPending && <p className="settings-hint">{t("runnerRecovery.stopHint")}</p>}
          {entry.launchUncertain && (
            <p className="settings-hint">{t("runnerRecovery.uncertainHint")}</p>
          )}
          {entry.connection === "legacy" && (
            <p className="settings-hint">{t("runnerRecovery.legacyHint")}</p>
          )}
          {entry.connection === "changed" && (
            <p className="settings-hint">{t("runnerRecovery.changedHint")}</p>
          )}
          {observation && (
            <div className="runner-recovery__observation" role="status">
              <strong>{t(`runnerRecovery.observed.${observation.status}`)}</strong>
              <span>
                {t("runnerRecovery.checkedAt", {
                  time: new Date(observation.checkedAt).toLocaleString(i18n.language),
                })}
              </span>
              {observation.error && <p>{observation.error}</p>}
            </div>
          )}
          <div className="runner-recovery__actions">
            {entry.canInspect && (
              <Button size="sm" disabled={pending} onClick={() => onAction("inspect")}>
                {t("runnerRecovery.inspect")}
              </Button>
            )}
            {entry.canReviewDestination && (
              <Button size="sm" disabled={pending} onClick={() => onAction("reviewDestination")}>
                {t("runnerRecovery.reviewDestination")}
              </Button>
            )}
            {entry.canHandoff && (
              <Button size="sm" disabled={pending} onClick={() => onAction("handoff")}>
                {t("runnerRecovery.handoff")}
              </Button>
            )}
            {entry.canStop && (
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => onAction("stop")}
              >
                {t("runnerRecovery.stop")}
              </Button>
            )}
            {entry.canForget && (
              <Button size="sm" disabled={pending} onClick={() => onAction("forget")}>
                {t("runnerRecovery.forget")}
              </Button>
            )}
          </div>
        </div>
      </details>
    </article>
  );
}
