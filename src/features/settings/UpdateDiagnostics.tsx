import { FileText, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type { UpdateSourceFailure } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { formatDateTime } from "@/lib/text/format";
import { useNavigation } from "@/store/navigation";

const SOURCE_LABELS = {
  "github-api": "updates.sourceApi",
  "github-public-feed": "updates.sourcePublic",
  "github-release": "updates.sourceRelease",
  "custom-update-source": "updates.sourceCustom",
} as const;

export function UpdateDiagnostics({ failures }: { failures: UpdateSourceFailure[] }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  return (
    <div className="settings-update__diagnostics" aria-label={t("updates.diagnostics")}>
      <dl className="settings-update__sources">
        {failures.map((failure, index) => (
          <div key={`${failure.source}:${index}`}>
            <dt>{t(SOURCE_LABELS[failure.source] ?? "updates.sourceCustom")}</dt>
            <dd>
              <span>{translateError({ code: "update", message: failure.reason })}</span>
              {failure.status !== null ? (
                <span className="settings-row__hint">HTTP {failure.status}</span>
              ) : null}
              {failure.retryAt !== null ? (
                <span className="settings-row__hint">
                  {t("updates.retryAt", { time: formatDateTime(failure.retryAt, locale) })}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {failures.some((failure) => failure.source === "github-api" && failure.retryAt !== null) ? (
        <p className="settings-row__hint">{t("updates.rateLimitRetryHint")}</p>
      ) : null}
      <div className="updates__actions">
        <Button
          size="sm"
          variant="ghost"
          leading={<Settings2 size={13} />}
          onClick={() => useNavigation.getState().selectSettings("network")}
        >
          {t("updates.configureProxy")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leading={<FileText size={13} />}
          onClick={() => useNavigation.getState().showOutput()}
        >
          {t("updates.showLogs")}
        </Button>
      </div>
    </div>
  );
}
