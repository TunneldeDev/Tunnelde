import { Check, ChevronRight, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ColorPicker } from "@/components/ui/form/ColorPicker";
import { IconButton } from "@/components/ui/form/Button";
import type { ColorRegion, Settings } from "@/lib/api/types";
import { COLOR_REGIONS, defaultRegionColor, previewColors } from "@/lib/prefs/colors";
import { useResolvedTheme } from "@/lib/prefs/useResolvedTheme";
import {
  BUILTIN_THEMES,
  isThemeActive,
  themePatch,
  themeSwatches,
  type ThemeDefinition,
} from "@/lib/prefs/themes";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";

export function RegionColors({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const theme = useResolvedTheme(settings.theme);
  const plugins = usePlugins((state) => state.items);
  const loadPlugins = usePlugins((state) => state.load);
  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);
  const installed = plugins.filter((plugin) => plugin.themes?.length);
  const active = [
    ...BUILTIN_THEMES.map((preset) => ({ id: preset.id as string, preset })),
    ...installed.flatMap((plugin) =>
      plugin.themes!.map((preset) => ({ id: `${plugin.id}:${preset.id}`, preset })),
    ),
  ].find(({ preset }) => isThemeActive(preset, settings))?.id;
  const customized = !active;
  const choice = (preset: ThemeDefinition, name: string, id: string) => {
    const selected = active === id;
    const swatches = themeSwatches(preset, theme);
    return (
      <button
        type="button"
        key={id}
        className="settings-theme-choice"
        aria-pressed={selected}
        onClick={() => {
          previewColors(null);
          void useSettings.getState().update(themePatch(preset));
        }}
      >
        <span
          className="settings-theme-preview"
          aria-hidden="true"
          style={{ backgroundColor: swatches[0] }}
        >
          <span style={{ backgroundColor: swatches[1] }} />
          <span style={{ backgroundColor: swatches[2] }}>
            <i style={{ backgroundColor: swatches[3] }} />
            <i />
            <i />
          </span>
        </span>
        <span className="settings-theme-name">
          <bdi>{name}</bdi>
          {selected ? <Check size={13} aria-hidden="true" /> : null}
        </span>
      </button>
    );
  };
  const change = (region: ColorRegion, value: string | null) => {
    const store = useSettings.getState();
    const colors = { ...store.settings.colors };
    if (value) colors[region] = value;
    else delete colors[region];
    void store.update({ colors });
  };
  return (
    <div className="settings-themes">
      <div className="settings-theme-choices" role="group" aria-label={t("themes.builtIn")}>
        {BUILTIN_THEMES.map((preset) => choice(preset, t(`themes.${preset.id}`), preset.id))}
      </div>
      {installed.length ? (
        <div className="settings-theme-library">
          {installed.map((plugin) => (
            <div className="settings-theme-source" key={plugin.id}>
              <p className="settings-theme-source-name">
                <bdi>{t("themes.pluginSource", { name: plugin.name })}</bdi>
                {plugin.author ? (
                  <span>
                    <bdi>{plugin.author}</bdi>
                  </span>
                ) : null}
              </p>
              <div className="settings-theme-choices" role="group" aria-label={plugin.name}>
                {plugin.themes!.map((preset) =>
                  choice(preset, preset.name, `${plugin.id}:${preset.id}`),
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {customized ? <p className="settings-row__hint">{t("themes.customized")}</p> : null}
      <details className="settings-color-customize">
        <summary>
          <ChevronRight size={13} aria-hidden="true" />
          {t("themes.customize")}
        </summary>
        <div className="settings-colors-grid">
          {(["workbench", "terminal"] as const).map((group) => (
            <fieldset className="settings-color-group" key={group}>
              <legend>{t(`themes.${group}`)}</legend>
              {COLOR_REGIONS.filter(
                (region) => region.startsWith("terminal") === (group === "terminal"),
              ).map((region) => {
                const fallback = defaultRegionColor(region, theme);
                const label = t(`color.region.${region}`);
                return (
                  <div className="settings-color-region" key={region}>
                    <div>
                      <span>{label}</span>
                      {!settings.colors[region] ? <small>{t("color.themeDefault")}</small> : null}
                    </div>
                    <ColorPicker
                      label={label}
                      value={settings.colors[region] ?? fallback}
                      defaultValue={fallback}
                      onChange={(color) => change(region, color)}
                      onReset={() => change(region, null)}
                      onPreview={(color) =>
                        previewColors(color ? { colors: { [region]: color } } : null)
                      }
                    />
                    <IconButton
                      size="sm"
                      label={t("settings.restoreOne", { name: label })}
                      disabled={!settings.colors[region]}
                      onClick={() => change(region, null)}
                    >
                      <RotateCcw size={13} />
                    </IconButton>
                  </div>
                );
              })}
            </fieldset>
          ))}
          <p className="settings-row__hint settings-color-native">{t("color.nativeTitle")}</p>
        </div>
      </details>
    </div>
  );
}
