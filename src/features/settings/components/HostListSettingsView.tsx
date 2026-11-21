import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";
import { Button } from "@/components/ui/form/Button";
import type { Settings } from "@/lib/api/types";
export function HostListSettingsView({
  preferences,
  onViewChange,
  onReset,
}: {
  preferences: Settings["hostList"];
  onViewChange(view: "tree" | "table"): void;
  onReset(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-row" data-setting="hostList">
      <div className="settings-row__text">
        <span className="settings-row__label">{t("hostColumns.view")}</span>
        <p className="settings-row__hint">{t("hostColumns.settingsHint")}</p>
      </div>
      <div className="settings-row__control">
        <Select
          label={t("hostColumns.view")}
          value={preferences.view}
          options={[
            { value: "tree", label: t("hostColumns.tree") },
            { value: "table", label: t("hostColumns.table") },
          ]}
          onChange={(value) => onViewChange(value === "table" ? "table" : "tree")}
        />
        <Button variant="ghost" size="sm" onClick={onReset}>
          {t("hostColumns.reset")}
        </Button>
      </div>
    </div>
  );
}
