import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";

export function PluginErrorView({
  message,
  onCopy,
}: {
  message: string;
  onCopy(message: string): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-message is-error" role="alert">
      <p style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{message}</p>
      <Button size="sm" variant="ghost" onClick={() => onCopy(message)}>
        {t("common.copy")}
      </Button>
    </div>
  );
}
