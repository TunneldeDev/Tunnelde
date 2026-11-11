import { useTranslation } from "react-i18next";
import type { RecoveryCapabilityObservation } from "@/lib/runners/recovery/contracts";

/** Capability discovery is informational and never implies process/file settlement. */
export function HelperCapabilities({
  observation,
}: {
  observation: RecoveryCapabilityObservation;
}) {
  const { t, i18n } = useTranslation();
  const result = observation.result;
  return (
    <div className="runner-recovery__observation runner-recovery__capabilities" role="status">
      <strong>{t("runnerRecovery.capabilities.title")}</strong>
      {result.status === "available" ? (
        <dl>
          <dt>{t("runnerRecovery.capabilities.version")}</dt>
          <dd>{result.envelope.helperVersion}</dd>
          <dt>{t("runnerRecovery.capabilities.protocols")}</dt>
          <dd>
            {result.envelope.runnerProtocols.join(", ") || t("runnerRecovery.capabilities.none")}
          </dd>
          <dt>{t("runnerRecovery.capabilities.features")}</dt>
          <dd>{result.envelope.features.join(", ") || t("runnerRecovery.capabilities.none")}</dd>
        </dl>
      ) : (
        <p>
          {t(`runnerRecovery.capabilities.failure.${result.reason}`)}
          {result.exitCode !== undefined &&
            ` (${t("runnerRecovery.capabilities.exitCode", { code: result.exitCode })})`}
        </p>
      )}
      <span>
        {t("runnerRecovery.checkedAt", {
          time: new Date(observation.checkedAt).toLocaleString(i18n.language),
        })}
      </span>
      <p className="settings-hint">{t("runnerRecovery.capabilities.hint")}</p>
    </div>
  );
}
