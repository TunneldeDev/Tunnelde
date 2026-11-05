import { Activity } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { api } from "@/lib/api/ipc";
import {
  isIpcError,
  type ConnectionQuality as Quality,
  type SshConnectRequest,
} from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import "./connectionQuality.css";

interface Props {
  hostId: string;
  credentials: NonNullable<SshConnectRequest["jumpCredentials"]>;
  enabled: boolean;
  onTesting: (testing: boolean) => void;
  onKeyError: () => void;
}

export function ConnectionQuality(props: Props) {
  const [scope, setScope] = useState({
    hostId: props.hostId,
    credentials: props.credentials,
    enabled: props.enabled,
    generation: 0,
  });
  if (
    scope.hostId !== props.hostId ||
    scope.credentials !== props.credentials ||
    scope.enabled !== props.enabled
  ) {
    setScope({
      hostId: props.hostId,
      credentials: props.credentials,
      enabled: props.enabled,
      generation: scope.generation + 1,
    });
  }
  // A new route gets a fresh test component. Cleanup cancels the previous native
  // request so that results and in-progress state cannot leak into the new route.
  return <QualityTest key={scope.generation} {...props} />;
}

function QualityTest({ hostId, credentials, enabled, onTesting, onKeyError }: Props) {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<Quality | null>(null);
  const [testing, setTesting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const request = useRef<string | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const id = request.current;
      request.current = null;
      if (id) {
        void api.sshCancelTest(id).catch(() => undefined);
        onTesting(false);
      }
    };
  }, [onTesting]);

  const run = async () => {
    if (!enabled || request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setTesting(true);
    setCancelling(false);
    setError(null);
    setResult(null);
    onTesting(true);
    try {
      const result = await api.sshTestConnection(id, hostId, credentials);
      if (active.current && request.current === id) setResult(result);
    } catch (cause) {
      if (active.current && request.current === id) {
        setError(translateError(cause));
        if (
          isIpcError(cause) &&
          ["ssh.hostKeyChanged", "ssh.hostKeyUntrusted"].includes(cause.message)
        ) {
          onKeyError();
        }
      }
    } finally {
      if (request.current === id) {
        request.current = null;
        if (active.current) {
          setTesting(false);
          setCancelling(false);
          onTesting(false);
        }
      }
    }
  };

  const cancel = async () => {
    const id = request.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await api.sshCancelTest(id);
    } catch (cause) {
      if (active.current && request.current === id) {
        setError(translateError(cause));
        setCancelling(false);
      }
    }
  };

  const ms = (value: number | null) =>
    value === null
      ? "—"
      : t("connect.testMs", {
          value: new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 0 }).format(
            value,
          ),
        });
  return (
    <section className="connection-quality" aria-label={t("connect.testTitle")}>
      <div className="connection-quality__head">
        <span className="connection-quality__title">
          <Activity size={13} />
          {t("connect.testTitle")}
        </span>
        {testing ? (
          <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => void cancel()}>
            {t("common.cancel")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => void run()}>
            {result ? t("connect.testAgain") : t("connect.test")}
          </Button>
        )}
      </div>
      {testing ? (
        <p className="connect__hint" role="status">
          {t("connect.testRunning")}
        </p>
      ) : null}
      {enabled && result ? (
        <div className="connection-quality__result">
          <span className={`connection-quality__rating is-${result.quality}`}>
            {t(`connect.testQuality.${result.quality}`)}
          </span>
          <dl className="connection-quality__metrics">
            <div>
              <dt>{t("connect.testMedian")}</dt>
              <dd>{ms(result.medianMs)}</dd>
            </div>
            <div>
              <dt>{t("connect.testSuccess")}</dt>
              <dd>
                {result.successful} / {result.attempts}
              </dd>
            </div>
            <div>
              <dt>{t("connect.testSpread")}</dt>
              <dd>{ms(result.spreadMs)}</dd>
            </div>
          </dl>
          <details className="connection-quality__samples">
            <summary>{t("connect.testSamples")}</summary>
            <ol>
              {result.samplesMs.map((sample, index) => (
                <li key={index}>{sample === null ? t("connect.testFailed") : ms(sample)}</li>
              ))}
            </ol>
            {result.lastError ? (
              <p className="connect__error">
                {translateError({ code: "ssh", message: result.lastError })}
              </p>
            ) : null}
          </details>
        </div>
      ) : null}
      {error ? (
        <p className="connect__error" role="status">
          {error}
        </p>
      ) : null}
      <p className="connect__hint">
        {enabled ? t("connect.testHint") : t("connect.testTrustFirst")}
      </p>
    </section>
  );
}
