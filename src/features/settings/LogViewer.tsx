import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import { useNavigation } from "@/store/navigation";
import "./logViewer.css";

export function LogViewer() {
  const { t } = useTranslation();
  return (
    <div className="settings-preference-group log-settings">
      <h3 className="settings-preference-group__title">{t("logs.title")}</h3>
      <div className="settings-preference-group__body log-settings__body">
        <p className="settings-row__hint">{t("logs.description")}</p>
        <Button
          size="sm"
          leading={<FileText size={14} />}
          onClick={() => useNavigation.getState().showOutput()}
        >
          {t("output.show")}
        </Button>
      </div>
    </div>
  );
}
