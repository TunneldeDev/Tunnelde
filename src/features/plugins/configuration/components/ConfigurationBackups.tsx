import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { pluginConfigurationApi } from "@/lib/api/plugins/configuration";
import { translateError } from "@/lib/api/errors";
import type { PluginInfo } from "@/lib/api/types";
import type { ConfigurationBackup } from "@/lib/extensions/contracts/configuration/document";

export function ConfigurationBackups({
  plugin,
  revision,
  pending,
  onRestore,
  onDelete,
}: {
  plugin: PluginInfo;
  revision: string;
  pending: boolean;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [backups, setBackups] = useState<ConfigurationBackup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState(0);
  useEffect(() => {
    let alive = true;
    void pluginConfigurationApi
      .backups(plugin.id, plugin.fingerprint ?? "")
      .then((items) => {
        if (alive) {
          setBackups(items);
          setError(null);
        }
      })
      .catch((error) => {
        if (alive) setError(translateError(error));
      });
    return () => {
      alive = false;
    };
  }, [plugin.id, plugin.fingerprint, revision, sequence, pending]);
  return (
    <details className="plugin-configuration__backups">
      <summary>{t("configuration.backups")}</summary>
      <p className="settings-hint">{t("configuration.backupsHint")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <Button size="sm" disabled={pending} onClick={() => setSequence((value) => value + 1)}>
        {t("common.refresh")}
      </Button>
      {!backups.length && !error ? <p>{t("configuration.noBackups")}</p> : null}
      {backups.map((backup) => (
        <article key={backup.id} className="plugin-configuration__backup">
          <div>
            <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
            <span>
              v{backup.document.schemaVersion} ·{" "}
              {t(
                backup.reason === "migration"
                  ? "configuration.reason.migration"
                  : "configuration.reason.restore",
              )}
            </span>
          </div>
          <Button size="sm" disabled={pending} onClick={() => onRestore(backup.id)}>
            {t("configuration.restore")}
          </Button>
          <Button
            size="sm"
            variant="ghost-danger"
            disabled={pending}
            onClick={() => onDelete(backup.id)}
          >
            {t("common.delete")}
          </Button>
          <details>
            <summary>{t("configuration.storedValues")}</summary>
            <pre>{JSON.stringify(backup.document.values, null, 2)}</pre>
          </details>
        </article>
      ))}
    </details>
  );
}
