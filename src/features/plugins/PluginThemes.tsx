import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type { PluginTheme } from "@/lib/api/types";
import { isThemeActive, themePatch, themeSwatches } from "@/lib/prefs/themes";
import { useSettings } from "@/store/settings";

export function PluginThemes({
  themes,
  disabled = false,
}: {
  themes: PluginTheme[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  return (
    <section className="plugin-detail__themes" aria-label={t("plugins.themes")}>
      <h2>{t("plugins.themes")}</h2>
      <div className="plugin-theme-list">
        {themes.map((theme) => {
          const active = isThemeActive(theme, settings);
          return (
            <article className="plugin-theme" key={theme.id} aria-label={theme.name}>
              <div className="plugin-theme__swatches" aria-hidden="true">
                {themeSwatches(theme).map((color, index) => (
                  <span key={index} style={{ background: color }} />
                ))}
              </div>
              <h3>{theme.name}</h3>
              <Button
                size="sm"
                variant={active ? "ghost" : "primary"}
                leading={active ? <Check size={13} /> : undefined}
                aria-pressed={active}
                disabled={disabled || active}
                onClick={() => void useSettings.getState().update(themePatch(theme))}
              >
                {t(active ? "plugins.themeApplied" : "plugins.applyTheme")}
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
