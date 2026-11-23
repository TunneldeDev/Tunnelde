import { Download, Plus, Settings2, Trash2, Upload } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { presentError } from "@/lib/api/errors";
import { validateUserCss } from "@/lib/prefs/appearance";
import {
  sameSettings,
  type SettingsDocument,
  type SettingsProfile,
  type PortableSettings,
} from "@/lib/prefs/profiles";
import type { ConfirmOptions } from "@/store/dialogs";
import type { SettingsControlState } from "./controlState";
import type { ApplySettingsProfile } from "@/lib/prefs/profiles";
import "../settingsProfiles.css";

export interface SettingsProfilesData {
  snapshot: PortableSettings;
  saving: boolean;
  profiles: SettingsProfile[];
  selectedId: string | null;
  revision: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  appDialogOpen: boolean;
  nativeAvailable: boolean;
}
export interface SettingsProfilesServices {
  useData(): SettingsProfilesData;
  useViewState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
  readCurrent(): Pick<SettingsProfilesData, "saving" | "busy" | "revision">;
  load(): Promise<void>;
  refresh(): Promise<void>;
  save(id: string | null, name: string, settings: PortableSettings): Promise<boolean>;
  saveCurrent(id: string, name: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  apply(request: ApplySettingsProfile): Promise<boolean>;
  confirm(options: ConfirmOptions): void;
  importFile(): Promise<SettingsDocument | null>;
  exportFile(name: string, settings: PortableSettings): Promise<string | null>;
  notify(message: string, kind: "error" | "success"): void;
}
export function SettingsProfilesView({
  hasDraft,
  services,
  onApplied,
}: {
  hasDraft: boolean;
  services: SettingsProfilesServices;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const {
    snapshot: currentSnapshot,
    saving,
    profiles,
    selectedId,
    loading,
    busy,
    error,
    appDialogOpen,
    nativeAvailable,
  } = services.useData();
  const { load, refresh, save, remove, useViewState, useBusyGuard } = services;
  const [managing, setManaging] = useViewState("settings:profiles:managing", false);
  const [naming, setNaming] = useViewState<{
    id: string | null;
    name: string;
    settings: PortableSettings;
  } | null>("settings:profiles:naming", null);
  const [nameError, setNameError] = useViewState<string | null>(
    "settings:profiles:nameError",
    null,
  );
  const [preview, setPreview] = useViewState<SettingsDocument | null>(
    "settings:profiles:preview",
    null,
  );
  const [working, setWorking] = useState(false);
  const nameId = useId();
  const disabled = saving || busy || loading || working;
  useBusyGuard(working || busy || saving || appDialogOpen);
  const selected = profiles.find((profile) => profile.id === selectedId);
  const modified = !!selected && !sameSettings(selected.settings, currentSnapshot);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (snapshot: PortableSettings, id: string | null, revision: string | null) => {
    const current = services.readCurrent();
    if (current.saving || current.busy || working) return;
    if (!id && !validateUserCss(snapshot.userCss ?? "").ok) {
      services.notify(t("settings.cssRejected"), "error");
      return;
    }
    setWorking(true);
    try {
      if (id && !revision) {
        services.notify(t("profiles.conflict"), "error");
        void load();
        return;
      }
      if (
        await services.apply(
          id
            ? { source: "saved", id, revision: revision! }
            : { source: "import", settings: snapshot },
        )
      ) {
        await refresh();
        setPreview(null);
        onApplied();
        services.notify(t("profiles.applied"), "success");
      } else void load();
    } finally {
      setWorking(false);
    }
  };
  const requestApply = (snapshot: PortableSettings, id: string | null) => {
    const revision = services.readCurrent().revision;
    if (hasDraft) {
      services.confirm({
        title: t("profiles.discardDraftTitle"),
        body: t("profiles.discardDraft"),
        confirmLabel: t("common.apply"),
        onConfirm: () => apply(snapshot, id, revision),
      });
    } else void apply(snapshot, id, revision);
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
      const document = await services.importFile();
      if (document) setPreview(document);
    } catch (failure) {
      services.notify(presentError(failure), "error");
    } finally {
      setWorking(false);
    }
  };
  const exportFile = async (profile?: SettingsProfile) => {
    if (disabled) return;
    setWorking(true);
    try {
      const path = await services.exportFile(
        profile?.name ?? selected?.name ?? t("profiles.current"),
        profile?.settings ?? currentSnapshot,
      );
      if (path) services.notify(t("profiles.exported", { path }), "success");
    } catch (failure) {
      services.notify(presentError(failure), "error");
    } finally {
      setWorking(false);
    }
  };
  const updateProfile = () => {
    if (!selected) return;
    services.confirm({
      title: t("profiles.updateTitle", { name: selected.name }),
      body: t("profiles.updateConfirm"),
      confirmLabel: t("common.save"),
      onConfirm: async () => {
        await services.saveCurrent(selected.id, selected.name);
      },
    });
  };
  const changed = preview
    ? Object.entries(preview.settings).filter(
        ([key, value]) =>
          !sameSettings(value, currentSnapshot[key as keyof typeof currentSnapshot]),
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
            else requestApply(currentSnapshot, null);
          }}
        />
        <Button
          size="sm"
          leading={<Plus size={13} />}
          disabled={disabled || !nativeAvailable || profiles.length >= 32}
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
          disabled={disabled || !nativeAvailable}
          onClick={() => void importFile()}
        >
          <Download size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("profiles.export")}
          disabled={disabled || !nativeAvailable}
          onClick={() => void exportFile()}
        >
          <Upload size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("profiles.manage")}
          disabled={disabled || !nativeAvailable}
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
                    services.confirm({
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
