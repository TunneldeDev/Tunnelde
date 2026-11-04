import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";
import { installedIconThemes } from "@/lib/files/icons";
import { usePlugins } from "@/store/plugins";

export function FileIconThemeSetting({
  value,
  descriptionId,
  onChange,
}: {
  value: string;
  descriptionId: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const plugins = usePlugins((state) => state.items);
  const themes = useMemo(() => installedIconThemes(plugins), [plugins]);
  const options = [
    { value: "auto", label: t("fileIcons.automatic") },
    { value: "none", label: t("fileIcons.none") },
    ...themes.map((theme) => ({ value: theme.id, label: `${theme.name} · ${theme.plugin}` })),
  ];
  if (!options.some((option) => option.value === value))
    options.push({ value, label: t("fileIcons.missing", { id: value }) });
  return (
    <Select
      label={t("settings.fileIconTheme")}
      descriptionId={descriptionId}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}
