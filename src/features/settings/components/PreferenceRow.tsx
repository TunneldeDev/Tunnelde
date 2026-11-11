import { useId } from "react";
import { sameSettings as samePreference } from "@/lib/prefs/profiles";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { IconButton } from "@/components/ui/form/Button";
import { Switch } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { ColorPicker } from "@/components/ui/form/ColorPicker";
import type { Settings, SettingsPatch } from "@/lib/api/types";
import { ACCENT_SWATCHES } from "@/lib/prefs/defaults";
import { previewColors, resolveAccent } from "@/lib/prefs/colors";
import type { ResolvedTheme } from "@/lib/prefs/appearance";
import { cn } from "@/lib/text/format";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import type { SettingDefinition, SettingOption } from "../catalog";
import { NumberPreference } from "../NumberPreference";
import { RegionColors } from "../RegionColors";
import { FileIconThemeSetting } from "../FileIconThemeSetting";

export function PreferenceRow({
  definition,
  settings,
  defaults,
  onReset,
  resetVersion,
  theme,
}: {
  definition: SettingDefinition;
  settings: Settings;
  defaults: Settings;
  onReset: () => void;
  resetVersion: number;
  theme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const update = useSettings((state) => state.update);
  const updatesBusy = useUpdates(
    (state) => state.busy || state.state?.phase === "downloading" || state.state?.phase === "ready",
  );
  const label = t(definition.label);
  const value = settings[definition.key];
  const defaultValue = defaults[definition.key];
  const modified = !samePreference(value, defaultValue);
  const disabled =
    (definition.dependsOn ? !settings[definition.dependsOn] : false) ||
    (definition.section === "updates" && updatesBusy);
  const setValue = (next: string | number | boolean) =>
    void update({ [definition.key]: next } as SettingsPatch);
  const optionLabel = (option: SettingOption) => (option.literal ? option.label : t(option.label));
  const formatValue = (next: Settings[typeof definition.key]) => {
    if (typeof next === "boolean") return t(next ? "settings.enabled" : "settings.disabled");
    if (definition.kind === "colors") return t("color.themeDefault");
    const option = definition.options?.find((item) => item.value === next);
    if (option) return optionLabel(option);
    if (definition.kind === "accent") {
      const swatch = ACCENT_SWATCHES.find((item) => item.id === next);
      if (swatch) return t(swatch.labelKey);
    }
    return `${next}${definition.unit ? ` ${definition.unit}` : ""}`;
  };
  return (
    <div
      className={cn(
        "settings-row",
        definition.kind === "colors" && "settings-row--colors",
        modified && "is-modified",
        disabled && "is-disabled",
      )}
      data-setting={definition.key}
    >
      <div className="settings-row__text" id={descriptionId}>
        <span className="settings-row__label">
          {label}
          {modified ? (
            <span
              className="settings-row__modified"
              title={t("settings.modified")}
              aria-label={t("settings.modified")}
            />
          ) : null}
        </span>
        {definition.hint ? <span className="settings-row__hint">{t(definition.hint)}</span> : null}
        <span className="settings-row__default">
          {t("settings.defaultValue", { value: formatValue(defaultValue) })}
          {definition.kind === "number"
            ? ` · ${t("settings.valueRange", { min: definition.min, max: definition.max })}`
            : ""}
        </span>
      </div>
      <div
        className="settings-row__control"
        aria-describedby={definition.hint ? descriptionId : undefined}
      >
        {definition.kind === "toggle" ? (
          <Switch
            label={label}
            checked={Boolean(value)}
            disabled={disabled}
            onChange={setValue}
            descriptionId={descriptionId}
          />
        ) : null}
        {definition.kind === "number" ? (
          <NumberPreference
            key={resetVersion}
            label={label}
            descriptionId={descriptionId}
            value={Number(value)}
            min={definition.min!}
            max={definition.max!}
            step={definition.step}
            unit={definition.unit}
            disabled={disabled}
            onChange={setValue}
          />
        ) : null}
        {definition.kind === "select" ? (
          <Select
            label={label}
            descriptionId={descriptionId}
            value={String(value)}
            disabled={disabled}
            options={definition.options!.map((option) => ({
              value: String(option.value),
              label: optionLabel(option),
            }))}
            onChange={(next) => setValue(typeof defaultValue === "number" ? Number(next) : next)}
          />
        ) : null}
        {definition.kind === "fileIcons" ? (
          <FileIconThemeSetting
            value={String(value)}
            descriptionId={descriptionId}
            onChange={setValue}
          />
        ) : null}
        {definition.kind === "accent" ? (
          <ColorPicker
            label={label}
            value={String(value)}
            defaultValue={String(defaultValue)}
            presets={ACCENT_SWATCHES.map((preset) => ({
              value: preset.id,
              label: t(preset.labelKey),
              color: resolveAccent(preset.id, theme),
            }))}
            onChange={setValue}
            onPreview={(accent) => previewColors(accent ? { accent } : null)}
          />
        ) : null}
        <IconButton
          className="settings-reset"
          size="sm"
          label={t("settings.restoreOne", { name: label })}
          disabled={!modified || (definition.section === "updates" && updatesBusy)}
          onClick={onReset}
        >
          <RotateCcw size={13} />
        </IconButton>
      </div>
      {definition.kind === "colors" ? <RegionColors settings={settings} /> : null}
    </div>
  );
}
