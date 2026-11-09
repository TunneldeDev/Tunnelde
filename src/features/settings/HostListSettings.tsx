import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";
import { Button } from "@/components/ui/form/Button";
import { useSettings } from "@/store/settings";
import { defaultHostListPreferences } from "@/lib/hosts/columns";
export function HostListSettings() {
  const { t } = useTranslation();
  const preferences = useSettings((state) => state.settings.hostList);
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
          onChange={(value) =>
            void useSettings.getState().update({
              hostList: {
                ...useSettings.getState().settings.hostList,
                view: value === "table" ? "table" : "tree",
              },
            })
          }
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void useSettings.getState().update({
              hostList: {
                ...defaultHostListPreferences(),
                view: useSettings.getState().settings.hostList.view,
              },
            })
          }
        >
          {t("hostColumns.reset")}
        </Button>
      </div>
    </div>
  );
}
