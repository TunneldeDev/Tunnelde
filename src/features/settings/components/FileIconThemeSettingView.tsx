import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";

export function FileIconThemeSettingView({
  value,
  themes,
  descriptionId,
  onChange,
}: {
  value: string;
  themes: readonly { id: string; name: string; plugin: string }[];
  descriptionId: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
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
