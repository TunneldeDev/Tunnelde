import { FolderOpen, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Switch } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import {
  displayStoragePath,
  storageChild,
  type StorageCategory,
} from "@/lib/api/storage";
import { formatBytes } from "@/lib/text/format";
import { useStorage } from "@/store/storage";
import { toast } from "@/store/toasts";
import "./storageSettings.css";

export function StorageSettings() {
  const { t, i18n } = useTranslation();
  const { status, loading, busy, error, load, schedule, cancel, draft, setDraft } = useStorage();
  const storageError = (message: string) =>
    i18n.exists(message) ? t(message as "storage.invalidPlan") : message;
  const [selected, setSelected] = useState<StorageCategory[]>([]);
  const [picking, setPicking] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  const disabled = busy || loading || picking || !isTauri();
  const locked = disabled || !!status?.pending;
  const locations = status?.locations ?? [];
  const selectable = locations.filter((location) => !location.overridden);
  const pick = async (categories: StorageCategory[], batch: boolean) => {
    if (locked || !categories.length) return;
    setPicking(true);
    try {
      const parent = await api.storagePick();
      if (parent) {
        const changes = categories.map((category) => ({
          category,
          target: batch ? storageChild(parent, category) : parent,
          migrate: true,
        }));
        setDraft((previous) => [
          ...previous.filter((item) => !categories.includes(item.category)),
          ...changes,
        ]);
      }
    } catch (failure) {
      toast(translateError(failure), "error");
    } finally {
      setPicking(false);
    }
  };
  return (
    <div className="storage-settings">
      <p className="settings-row__hint">{t("storage.description")}</p>
      <div className="storage-settings__toolbar">
        <label className="storage-settings__check">
          <input
            type="checkbox"
            disabled={locked || !selectable.length}
            checked={
              !!selectable.length &&
              selectable.every((location) => selected.includes(location.category))
            }
            onChange={(event) =>
              setSelected(
                event.target.checked ? selectable.map((location) => location.category) : [],
              )
            }
          />
          {t("storage.selectAll")}
        </label>
        <Button
          size="sm"
          disabled={locked || !selected.length}
          leading={<FolderOpen size={14} />}
          onClick={() => void pick(selected, true)}
        >
          {t("storage.batchChoose", { count: selected.length })}
        </Button>
        <IconButton
          label={t("common.refresh")}
          size="sm"
          disabled={disabled}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error ? (
        <p className="settings-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {status?.lastError ? (
        <p className="settings-message is-error" role="alert">
          {t("storage.migrationFailed")} {storageError(status.lastError)}
        </p>
      ) : null}
      {loading && !status ? (
        <p role="status" className="settings-row__hint">
          {t("common.loading")}
        </p>
      ) : null}
      {status?.pending ? (
        <div className="storage-settings__pending" role="status">
          <strong>{t("storage.pending")}</strong>
          <p>{t("storage.restartHint")}</p>
          <Button size="sm" disabled={disabled} onClick={() => void cancel()}>
            {t("storage.cancelPlan")}
          </Button>
        </div>
      ) : null}
      <div className="storage-settings__locations">
        {locations.map((location) => {
          const next =
            status?.pending?.changes.find((item) => item.category === location.category) ??
            draft.find((item) => item.category === location.category);
          return (
            <div className="storage-settings__location" key={location.category}>
              <label className="storage-settings__check storage-settings__name">
                <input
                  type="checkbox"
                  disabled={locked || location.overridden}
                  checked={selected.includes(location.category)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, location.category]
                        : previous.filter((item) => item !== location.category),
                    )
                  }
                />
                {t(`storage.categories.${location.category}`)}
              </label>
              <div className="storage-settings__detail">
                <p className="settings-row__hint">{t(`storage.hints.${location.category}`)}</p>
                <code className="storage-settings__path" title={location.path}>
                  {displayStoragePath(location.path)}
                </code>
                <span className="storage-settings__size">
                  {location.error
                    ? storageError(location.error)
                    : t("storage.size", {
                        size: formatBytes(location.bytes),
                        count: location.files,
                      })}
                </span>
                {location.overridden ? (
                  <p className="settings-row__hint">{t("storage.overridden")}</p>
                ) : null}
                {next ? (
                  <div className="storage-settings__next">
                    <span>{t("storage.nextPath")}</span>
                    <code className="storage-settings__path" title={next.target}>
                      {displayStoragePath(next.target)}
                    </code>
                    <label className="storage-settings__migrate">
                      <Switch
                        label={t("storage.migrateCategory", {
                          category: t(`storage.categories.${location.category}`),
                        })}
                        checked={next.migrate}
                        disabled={locked}
                        onChange={(migrate) =>
                          setDraft((previous) =>
                            previous.map((item) =>
                              item.category === location.category ? { ...item, migrate } : item,
                            ),
                          )
                        }
                      />
                      {t(next.migrate ? "storage.migrate" : "storage.startEmpty")}
                    </label>
                    {!status?.pending ? (
                      <IconButton
                        size="sm"
                        label={t("storage.discardCategory", {
                          category: t(`storage.categories.${location.category}`),
                        })}
                        disabled={locked}
                        onClick={() =>
                          setDraft((previous) =>
                            previous.filter((item) => item.category !== location.category),
                          )
                        }
                      >
                        <X size={13} />
                      </IconButton>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="storage-settings__actions">
                <IconButton
                  label={t("storage.openCategory", {
                    category: t(`storage.categories.${location.category}`),
                  })}
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    void api
                      .storageOpen(location.category)
                      .catch((failure) => toast(translateError(failure), "error"))
                  }
                >
                  <FolderOpen size={14} />
                </IconButton>
                <Button
                  size="sm"
                  disabled={locked || location.overridden}
                  onClick={() => void pick([location.category], false)}
                >
                  {t("storage.change")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {draft.length && !status?.pending ? (
        <div className="storage-settings__toolbar">
          <Button variant="primary" disabled={locked} onClick={() => setReviewing(true)}>
            {t("storage.review", { count: draft.length })}
          </Button>
          <Button variant="ghost" disabled={locked} onClick={() => setDraft([])}>
            {t("settings.discardDraft")}
          </Button>
        </div>
      ) : null}
      {status && Object.keys(status.previous).length ? (
        <details className="storage-settings__recovery">
          <summary>{t("storage.recovery")}</summary>
          <p className="settings-row__hint">{t("storage.keptOriginals")}</p>
          {Object.entries(status.previous).map(([category, path]) => (
            <p key={category}>
              <span>{t(`storage.categories.${category as StorageCategory}`)}</span>
              <code className="storage-settings__path">{displayStoragePath(path)}</code>
            </p>
          ))}
        </details>
      ) : null}
      <p className="settings-row__hint">{t("storage.boundaries")}</p>
      <Dialog
        open={reviewing}
        title={t("storage.reviewTitle")}
        closeLabel={t("common.close")}
        width={640}
        dismissible={!busy}
        onClose={() => setReviewing(false)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setReviewing(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !!status?.pending}
              onClick={() =>
                void schedule(draft).then((ok) => {
                  if (ok) {
                    setDraft([]);
                    setReviewing(false);
                  }
                })
              }
            >
              {t("storage.schedule")}
            </Button>
          </>
        }
      >
        <p className="settings-row__hint">{t("storage.confirmHint")}</p>
        <div className="storage-settings__review">
          {draft.map((item) => (
            <div key={item.category}>
              <strong>{t(`storage.categories.${item.category}`)}</strong>
              <code className="storage-settings__path">
                {displayStoragePath(
                  locations.find((location) => location.category === item.category)?.path ?? "",
                )}
              </code>
              <code className="storage-settings__path">→ {displayStoragePath(item.target)}</code>
              <span className={item.migrate ? "settings-row__hint" : "settings-message is-error"}>
                {t(item.migrate ? "storage.migrate" : "storage.emptyWarning")}
              </span>
            </div>
          ))}
        </div>
        {error ? (
          <p className="settings-message is-error" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
