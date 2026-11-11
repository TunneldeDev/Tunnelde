import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type { PluginInfo } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { ConfigurationField } from "./ConfigurationField";
import { ConfigurationBackups } from "./ConfigurationBackups";
import { useConfiguration } from "../runtime/useConfiguration";
import { matchingConfigurationFields } from "../data/search";

export function ConfigurationForm({
  plugin,
  query,
  visible,
}: {
  plugin: PluginInfo;
  query: string;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const model = useConfiguration(plugin, visible);
  const confirm = useDialogs((state) => state.confirm);
  const { snapshot, draft, pending, dirty, error, outdated, invalid } = model;
  const fields = matchingConfigurationFields(plugin, query);
  const confirmAction = (title: string, body: string, action: () => unknown, danger = false) =>
    confirm({
      title,
      body,
      confirmLabel: title,
      danger,
      onConfirm: async () => {
        await action();
      },
    });
  return (
    <div className="plugin-configuration__form">
      {error ? (
        <p role="alert" className="td-field__error">
          {error}
        </p>
      ) : null}
      {pending ? <p role="status">{t("common.loading")}</p> : null}
      {outdated ? (
        <p role="status" className="settings-hint">
          {t("configuration.outdated")}
        </p>
      ) : null}
      {snapshot && snapshot.status !== "ready" ? (
        <div className="plugin-configuration__notice" role="status">
          <p>
            {t(
              snapshot.status === "migrationRequired"
                ? "configuration.migrationRequired"
                : "configuration.incompatible",
              { stored: snapshot.storedVersion, current: snapshot.schema.version },
            )}
          </p>
          <details>
            <summary>{t("configuration.storedValues")}</summary>
            <pre>{JSON.stringify(snapshot.values, null, 2)}</pre>
          </details>
          {snapshot.status === "migrationRequired" ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                confirmAction(
                  t("configuration.migrate"),
                  t("configuration.migrateBody"),
                  model.migrate,
                )
              }
            >
              {t("configuration.migrate")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot?.status === "ready"
        ? snapshot.schema.groups.map((group) => {
            const groupFields = fields.filter((field) => field.group === group.id);
            return (
              <section
                key={group.id}
                hidden={!groupFields.length}
                className="plugin-configuration__group"
                aria-label={group.title}
              >
                <h4>{group.title}</h4>
                {snapshot.schema.fields
                  .filter((field) => field.group === group.id)
                  .map((field) => (
                    <div key={field.id} hidden={!groupFields.some((item) => item.id === field.id)}>
                      <ConfigurationField
                        field={field}
                        draft={draft[field.id] ?? ""}
                        disabled={pending || !visible}
                        onChange={(value) => model.change(field.id, value)}
                      />
                    </div>
                  ))}
              </section>
            );
          })
        : null}
      <div className="plugin-configuration__actions">
        <Button
          size="sm"
          variant="primary"
          disabled={
            !snapshot ||
            !dirty ||
            pending ||
            !!invalid.length ||
            snapshot.status !== "ready" ||
            !visible
          }
          onClick={() => void model.save()}
        >
          {t("common.save")}
        </Button>
        <Button
          size="sm"
          disabled={pending || !visible}
          onClick={() =>
            dirty
              ? confirmAction(
                  t("configuration.reload"),
                  t("configuration.reloadBody"),
                  model.reload,
                )
              : void model.reload()
          }
        >
          {t("configuration.reload")}
        </Button>
        <span role="status">
          {dirty ? t("configuration.unsaved") : snapshot ? t("configuration.saved") : ""}
        </span>
      </div>
      {snapshot ? (
        <ConfigurationBackups
          plugin={plugin}
          revision={snapshot.revision}
          pending={pending}
          onRestore={(id) =>
            confirmAction(t("configuration.restore"), t("configuration.restoreBody"), () =>
              model.restore(id),
            )
          }
          onDelete={(id) =>
            confirmAction(
              t("configuration.deleteBackup"),
              t("configuration.deleteBackupBody"),
              () => model.deleteBackup(id),
              true,
            )
          }
        />
      ) : null}
    </div>
  );
}
