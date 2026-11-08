import { useEffect, useId, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { NetworkConnectionQuality, NetworkSettings } from "@/lib/api/network";
import { useBackgroundGuard } from "@/lib/session/viewState";
import "./networkConnectionTest.css";

export function NetworkConnectionTest({ settings }: { settings: NetworkSettings }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [proxy, setProxy] = useState("feature:marketplace");
  const [host, setHost] = useState("github.com");
  const [port, setPort] = useState("443");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{
    scope: string;
    quality: NetworkConnectionQuality | null;
    error: string | null;
  } | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useBackgroundGuard(testing);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const feature = proxy.startsWith("feature:") ? proxy.slice("feature:".length) : null;
  const selected =
    (feature ? settings.features[feature] : proxy) || settings.defaultProxy || "system";
  const scope = JSON.stringify([selected, settings.profiles, host.trim(), port]);
  const quality = result?.scope === scope ? result.quality : null;
  const error = result?.scope === scope ? result.error : null;
  const valid =
    host.trim().length > 0 && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const choices = [
    { value: "feature:marketplace", label: t("network.testMarketplaceRoute") },
    { value: "feature:updates", label: t("network.testUpdatesRoute") },
    { value: "", label: t("network.inherit") },
    { value: "system", label: t("network.system") },
    { value: "direct", label: t("network.direct") },
    ...settings.profiles.map((p) => ({ value: p.id, label: p.name })),
  ];
  const ms = (value: number | null) =>
    value === null
      ? "—"
      : value < 1
        ? t("network.qualityLessMs")
        : t("connect.testMs", {
            value: new Intl.NumberFormat(i18n.resolvedLanguage, {
              maximumFractionDigits: 0,
            }).format(value),
          });
  return (
    <section className="network-settings__section" aria-labelledby={`${id}-title`}>
      <div className="network-settings__head">
        <h3 id={`${id}-title`}>{t("network.test")}</h3>
      </div>
      <form
        className="network-settings__test"
        aria-labelledby={`${id}-title`}
        aria-busy={testing}
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || !valid) return;
          pending.current = true;
          setTesting(true);
          setResult(null);
          try {
            const quality = await api.testProxyQuality(selected, host.trim(), Number(port));
            if (alive.current) setResult({ scope, quality, error: null });
          } catch (cause) {
            if (alive.current) setResult({ scope, quality: null, error: translateError(cause) });
          } finally {
            pending.current = false;
            if (alive.current) setTesting(false);
          }
        }}
      >
        <Field label={t("network.proxy")} htmlFor={`${id}-proxy`}>
          <Select
            id={`${id}-proxy`}
            label={t("network.proxy")}
            value={proxy}
            options={choices}
            disabled={testing}
            onChange={(value) => {
              setProxy(value);
              setResult(null);
            }}
          />
        </Field>
        <div className="network-settings__endpoint">
          <Field label={t("network.testAddress")} htmlFor={`${id}-host`}>
            <Input
              id={`${id}-host`}
              spellCheck={false}
              autoComplete="off"
              disabled={testing}
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setResult(null);
              }}
            />
          </Field>
          <Field label={t("network.port")} htmlFor={`${id}-port`}>
            <Input
              id={`${id}-port`}
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              disabled={testing}
              value={port}
              onChange={(event) => {
                setPort(event.target.value);
                setResult(null);
              }}
            />
          </Field>
        </div>
        <div className="network-settings__test-actions">
          <Button type="submit" disabled={testing || !valid}>
            {t(testing ? "common.loading" : quality ? "connect.testAgain" : "network.test")}
          </Button>
          <p role="status" className="network-settings__result">
            {testing
              ? t("network.qualityRunning")
              : (error ??
                (quality
                  ? t(
                      quality.https?.success === false
                        ? "network.httpsFailed"
                        : `network.quality.${quality.quality}`,
                    )
                  : ""))}
          </p>
        </div>
        {quality ? (
          <section
            className={`network-quality is-${quality.https?.success === false ? "unreachable" : quality.quality}`}
            aria-label={t("connect.testTitle")}
          >
            <div className="network-quality__title">
              <Activity size={14} aria-hidden="true" />
              {t("connect.testTitle")}
            </div>
            <dl className="network-quality__metrics">
              {[
                [t("network.qualityLatency"), ms(quality.medianMs)],
                [t("connect.testSuccess"), `${quality.successful} / ${quality.attempts}`],
                [t("network.qualityFastest"), ms(quality.minMs)],
                [t("network.qualitySlowest"), ms(quality.maxMs)],
                [t("connect.testSpread"), ms(quality.spreadMs)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <details className="network-quality__samples">
              <summary>{t("connect.testSamples")}</summary>
              <ol>
                {quality.samplesMs.map((sample, index) => (
                  <li key={index}>{sample === null ? t("connect.testFailed") : ms(sample)}</li>
                ))}
              </ol>
            </details>
            {quality.https ? (
              <p
                className={
                  quality.https.success ? "network-settings__result" : "network-quality__error"
                }
              >
                {quality.https.success
                  ? t("network.httpsPassed", {
                      ms: ms(quality.https.elapsedMs),
                      status: quality.https.status,
                    })
                  : quality.https.error
                    ? translateError(quality.https.error)
                    : t("network.httpsFailed")}
              </p>
            ) : null}
            {quality.lastError ? (
              <p className="network-quality__error">{translateError(quality.lastError)}</p>
            ) : null}
          </section>
        ) : null}
        <p className="settings-row__hint">{t("network.qualityHint")}</p>
      </form>
    </section>
  );
}
