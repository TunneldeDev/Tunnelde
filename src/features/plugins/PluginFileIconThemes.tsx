import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { installedIconThemes } from "@/lib/files/icons";
import type { PluginInfo } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";

export function PluginFileIconThemes({
  plugin,
  disabled,
}: {
  plugin: PluginInfo;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const selected = useSettings((state) => state.settings.fileIconTheme);
  const plugins = usePlugins((state) => state.items);
  const automatic = selected === "auto" ? installedIconThemes(plugins)[0]?.id : undefined;
  return (
    <section className="plugin-detail__themes" aria-label={t("settings.fileIconTheme")}>
      <h2>{t("settings.fileIconTheme")}</h2>
      <div className="plugin-theme-list">
        {plugin.fileIconThemes?.map((theme) => {
          const id = `${plugin.id}:${theme.id}`;
          const active = selected === id || automatic === id;
          return (
            <article className="plugin-theme" key={theme.id} aria-label={theme.name}>
              <div className="settings-actions" aria-hidden="true">
                {Object.entries(theme.icons)
                  .slice(0, 6)
                  .map(([id, icon]) => (
                    <FileTypeIcon key={id} icon={icon} size={20} />
                  ))}
              </div>
              <h3>{theme.name}</h3>
              <Button
                size="sm"
                variant={active ? "ghost" : "primary"}
                disabled={disabled || active}
                leading={active ? <Check size={13} /> : undefined}
                aria-pressed={active}
                onClick={() => void useSettings.getState().update({ fileIconTheme: id })}
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
