import { Fragment, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { IconButton } from "@/components/ui/form/Button";
import type { Settings } from "@/lib/api/types";
import type { ResolvedTheme } from "@/lib/prefs/appearance";
import type { SettingsSection } from "@/store/navigation";
import { groupSettings, type SettingDefinition } from "../catalog";
import type { PreferenceRowProps } from "./PreferenceRow";

export interface PreferenceFieldsServices {
  renderFonts?(): ReactNode;
  renderTerminalPreview(): ReactNode;
  renderUpdateSource(props: { onReset(): void }): ReactNode;
  renderHostList(): ReactNode;
  renderCss(props: {
    draft: string | null;
    onDraft: Dispatch<SetStateAction<string | null>>;
  }): ReactNode;
  renderRow(props: PreferenceRowProps): ReactNode;
}
export function PreferenceFieldsView({
  section,
  definitions,
  settings,
  defaults,
  filtering,
  settingsId,
  resetVersions,
  theme,
  cssDraft,
  setCssDraft,
  onReset,
  isModified,
  services,
}: {
  section: SettingsSection;
  definitions: SettingDefinition[];
  settings: Settings;
  defaults: Settings;
  filtering: boolean;
  settingsId: string;
  resetVersions: Record<string, number>;
  theme: ResolvedTheme;
  cssDraft: string | null;
  setCssDraft: Dispatch<SetStateAction<string | null>>;
  onReset: (definition: SettingDefinition) => void;
  isModified: (definition: SettingDefinition) => boolean;
  services: PreferenceFieldsServices;
}) {
  const { t } = useTranslation();
  return (
    <>
      {groupSettings(section, definitions).map((group) => (
        <div
          key={group.id}
          id={`${settingsId}-${group.id}`}
          className={group.label ? "settings-preference-group" : undefined}
          data-settings-group={group.id}
        >
          {group.label ? (
            <h3 className="settings-preference-group__title">{t(group.label)}</h3>
          ) : null}
          <div className={group.label ? "settings-preference-group__body" : undefined}>
            {group.preview === "terminal" && !filtering ? (
              <div
                className="settings-preview"
                role="group"
                aria-labelledby={`${settingsId}-${group.id}-preview-title`}
                aria-describedby={`${settingsId}-${group.id}-preview-hint`}
              >
                <div className="settings-preview__head">
                  <h4
                    className="settings-preview__title"
                    id={`${settingsId}-${group.id}-preview-title`}
                  >
                    {t("terminal.previewLabel")}
                  </h4>
                  <p
                    className="settings-preview__hint"
                    id={`${settingsId}-${group.id}-preview-hint`}
                  >
                    {t("terminal.previewHint")}
                  </p>
                </div>
                {services.renderTerminalPreview()}
              </div>
            ) : null}
            {group.definitions.map((definition) =>
              definition.kind === "updateUrl" ? (
                !filtering && settings.updateSource !== "custom" ? null : (
                  <Fragment key={`${definition.key}-${resetVersions[definition.key] ?? 0}`}>
                    {services.renderUpdateSource({ onReset: () => onReset(definition) })}
                  </Fragment>
                )
              ) : definition.kind === "hostList" ? (
                <Fragment key={definition.key}>{services.renderHostList()}</Fragment>
              ) : definition.kind === "fonts" ? (
                <Fragment key={definition.key}>{services.renderFonts?.()}</Fragment>
              ) : definition.kind === "css" ? (
                <div key={definition.key} className="settings-css-group" data-setting="userCss">
                  <div className="settings-section__head">
                    <span>{t(definition.label)}</span>
                    <IconButton
                      size="sm"
                      label={t("settings.restoreOne", { name: t(definition.label) })}
                      disabled={!isModified(definition)}
                      onClick={() => onReset(definition)}
                    >
                      <RotateCcw size={13} />
                    </IconButton>
                  </div>
                  <p className="settings-row__hint">
                    {t(definition.hint!)} ·{" "}
                    {t("settings.defaultValue", { value: t("settings.cssEmpty") })}
                  </p>
                  {services.renderCss({ draft: cssDraft, onDraft: setCssDraft })}
                </div>
              ) : (
                <Fragment key={definition.key}>
                  {services.renderRow({
                    definition,
                    settings,
                    defaults,
                    onReset: () => onReset(definition),
                    resetVersion: resetVersions[definition.key] ?? 0,
                    theme,
                  })}
                </Fragment>
              ),
            )}
          </div>
        </div>
      ))}
    </>
  );
}
