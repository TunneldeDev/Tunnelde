import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { copyText } from "@/lib/session/clipboard";

export function PluginError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="settings-message is-error" role="alert">
      <p style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{message}</p>
      <Button size="sm" variant="ghost" onClick={() => copyText(message)}>
        {t("common.copy")}
      </Button>
    </div>
  );
}
