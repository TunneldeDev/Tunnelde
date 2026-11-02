import { Download, Plus, Settings2, Trash2, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { validateUserCss } from "@/lib/prefs/appearance";
import {
  portableSettings,
  sameSettings,
  type SettingsDocument,
  type SettingsProfile,
  type PortableSettings,
} from "@/lib/prefs/profiles";
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import { useSettingsProfiles } from "@/store/settingsProfiles";
import { toast } from "@/store/toasts";
import "./settingsProfiles.css";

export function SettingsProfiles({
  hasDraft,
  onApplied,
}: {
  hasDraft: boolean;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const saving = useSettings((state) => state.saving);
  const { profiles, selectedId, loading, busy, error, load, select, save, remove } =
    useSettingsProfiles();
  const [managing, setManaging] = useState(false);
  const [naming, setNaming] = useState<{
    id: string | null;
    name: string;
    settings: PortableSettings;
  } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SettingsDocument | null>(null);
  const [working, setWorking] = useState(false);
  const appDialogOpen = useDialogs((state) => state.dialog.kind !== "none");
  const nameId = useId();
  const disabled = saving || busy || loading || working;
  const currentSnapshot = useMemo(() => portableSettings(settings), [settings]);
  const matching = profiles.find((profile) => sameSettings(profile.settings, currentSnapshot));
  const selected = profiles.find((profile) => profile.id === selectedId) ?? matching;
  const modified = !!selected && !sameSettings(selected.settings, currentSnapshot);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (snapshot: PortableSettings, id: string | null) => {
    if (useSettings.getState().saving || useSettingsProfiles.getState().busy || working) return;
    if (!validateUserCss(snapshot.userCss ?? "").ok) {
      toast(t("settings.cssRejected"), "error");
      return;
    }
    setWorking(true);
    try {
      if (await useSettings.getState().update(snapshot)) {
        select(id);
        setPreview(null);
        onApplied();
        toast(t("profiles.applied"), "success");
      }
    } finally {
      setWorking(false);
    }
  };
  const requestApply = (snapshot: PortableSettings, id: string | null) => {
    if (hasDraft) {
      useDialogs.getState().confirm({
        title: t("profiles.discardDraftTitle"),
        body: t("profiles.discardDraft"),
        confirmLabel: t("common.apply"),
        onConfirm: () => apply(snapshot, id),
      });
    } else void apply(snapshot, id);
  };
  const saveName = async () => {
    if (!naming || disabled) return;
    const name = naming.name.trim();
    if (
      !name ||
      [...name].length > 64 ||
      [...name].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || (code >= 127 && code <= 159);
      })
    ) {
      setNameError(t("profiles.invalidName"));
      return;
    }
    if (
      profiles.some(
        (profile) =>
          profile.id !== naming.id && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setNameError(t("profiles.duplicateName"));
      return;
    }
    if (await save(naming.id, name, naming.settings)) {
      setNaming(null);
      setNameError(null);
    }
  };
  const importFile = async () => {
    if (disabled) return;
    setWorking(true);
    try {
      const document = await api.importSettingsFile();
      if (document) setPreview(document);
    } catch (failure) {
      toast(translateError(failure), "error");
    } finally {
      setWorking(false);
    }
  };
  const exportFile = async (profile?: SettingsProfile) => {
    if (disabled) return;
    setWorking(true);
    try {
      const path = await api.exportSettingsFile(
        profile?.name ?? selected?.name ?? t("profiles.current"),
        profile?.settings ?? currentSnapshot,
      );
      if (path) toast(t("profiles.exported", { path }), "success");
    } catch (failure) {
      toast(translateError(failure), "error");
    } finally {
      setWorking(false);
    }
  };
  const updateProfile = () => {
    if (!selected) return;
    useDialogs.getState().confirm({
      title: t("profiles.updateTitle", { name: selected.name }),
      body: t("profiles.updateConfirm"),
      confirmLabel: t("common.save"),
      onConfirm: async () => {
        await save(selected.id, selected.name, portableSettings(useSettings.getState().settings));
      },
    });
  };
  const changed = preview
    ? Object.entries(preview.settings).filter(
        ([key, value]) => !sameSettings(value, settings[key as keyof typeof settings]),
      ).length
    : 0;

  return (
    <>
      <div className="settings-profiles" role="group" aria-label={t("profiles.title")}>
        <span className="settings-profiles__label">{t("profiles.profile")}</span>
        <Select
          label={t("profiles.choose")}
          value={selected?.id ?? ""}
          disabled={disabled}
          options={[
            { value: "", label: t("profiles.current") },
            ...profiles.map((profile) => ({
              value: profile.id,
              label: `${profile.name}${profile.id === selected?.id && modified ? ` · ${t("settings.modified")}` : ""}`,
            })),
          ]}
          onChange={(id) => {
            const profile = profiles.find((entry) => entry.id === id);
            if (profile) requestApply(profile.settings, profile.id);
            else select(null);
          }}
        />
        <Button
          size="sm"
          leading={<Plus size={13} />}
          disabled={disabled || !isTauri() || profiles.length >= 32}
          onClick={() => {
            setNameError(null);
            setNaming({ id: null, name: "", settings: currentSnapshot });
          }}
        >
          {t("profiles.saveAs")}
        </Button>
        {modified ? (
          <Button size="sm" disabled={disabled} onClick={updateProfile}>
            {t("profiles.update")}
          </Button>
        ) : null}
        <span className="settings-profiles__spacer" />
        <IconButton
          size="sm"
          label={t("profiles.import")}
          disabled={disabled || !isTauri()}
          onClick={() => void importFile()}
        >
          <Download size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("profiles.export")}
          disabled={disabled || !isTauri()}
          onClick={() => void exportFile()}
        >
          <Upload size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("profiles.manage")}
          disabled={disabled || !isTauri()}
          onClick={() => {
            setManaging(true);
            void load();
          }}
        >
          <Settings2 size={14} />
        </IconButton>
      </div>
      {error ? (
        <div className="settings-profiles__error" role="alert">
          {error}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={managing && naming === null && !appDialogOpen}
        title={t("profiles.manage")}
        closeLabel={t("common.close")}
        onClose={() => setManaging(false)}
        width={580}
      >
        <p className="settings-row__hint">{t("profiles.scope")}</p>
        <p className="settings-row__hint">{t("profiles.snapshotHint")}</p>
        <div className="settings-profiles__list">
          {profiles.length ? (
            profiles.map((profile) => (
              <div className="settings-profiles__item" key={profile.id}>
                <span className="settings-profiles__name" title={profile.name}>
                  {profile.name}
                </span>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    setManaging(false);
                    requestApply(profile.settings, profile.id);
                  }}
                >
                  {t("common.apply")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setNameError(null);
                    setNaming({ id: profile.id, name: profile.name, settings: profile.settings });
                  }}
                >
                  {t("profiles.rename")}
                </Button>
                <IconButton
                  size="sm"
                  label={t("profiles.exportNamed", { name: profile.name })}
                  disabled={disabled}
                  onClick={() => void exportFile(profile)}
                >
                  <Upload size={14} />
                </IconButton>
                <IconButton
                  size="sm"
                  danger
                  label={t("profiles.deleteNamed", { name: profile.name })}
                  disabled={disabled}
                  onClick={() =>
                    useDialogs.getState().confirm({
                      title: t("profiles.deleteTitle", { name: profile.name }),
                      body: t("profiles.deleteConfirm"),
                      confirmLabel: t("common.delete"),
                      danger: true,
                      onConfirm: async () => {
                        await remove(profile.id);
                      },
                    })
                  }
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))
          ) : (
            <p className="settings-row__hint">{t("profiles.empty")}</p>
          )}
        </div>
      </Dialog>
      <Dialog
        open={naming !== null && !appDialogOpen}
        title={t(naming?.id ? "profiles.rename" : "profiles.saveAs")}
        closeLabel={t("common.close")}
        dismissible={!busy}
        onClose={() => setNaming(null)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setNaming(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={disabled || !naming?.name.trim()}
              onClick={() => void saveName()}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <label className="settings-profiles__input-label" htmlFor={nameId}>
            {t("profiles.name")}
          </label>
          <Input
            id={nameId}
            autoFocus
            value={naming?.name ?? ""}
            maxLength={128}
            disabled={busy}
            aria-invalid={!!nameError}
            onChange={(event) => {
              setNaming((previous) =>
                previous ? { ...previous, name: event.target.value } : null,
              );
              setNameError(null);
            }}
          />
          <p className="settings-row__hint">{t("profiles.nameHint")}</p>
          {nameError ? (
            <p role="alert" className="settings-message is-error">
              {nameError}
            </p>
          ) : null}
        </form>
      </Dialog>
      <Dialog
        open={preview !== null && !appDialogOpen}
        title={t("profiles.importPreview")}
        closeLabel={t("common.close")}
        dismissible={!working}
        onClose={() => setPreview(null)}
        footer={
          <>
            <Button disabled={working} onClick={() => setPreview(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() => {
                if (preview) requestApply(preview.settings, null);
              }}
            >
              {t("common.apply")}
            </Button>
          </>
        }
      >
        <p className="settings-profiles__preview-name">{preview?.name}</p>
        <p>{t("profiles.changeCount", { count: changed })}</p>
        <p className="settings-row__hint">{t("profiles.scope")}</p>
        <p className="settings-row__hint">{t("profiles.importHint")}</p>
      </Dialog>
    </>
  );
}
