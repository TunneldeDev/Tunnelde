import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { requestApplicationAction } from "@/lib/session/restart";
import { useRestartPrompt } from "@/store/restartPrompt";
import { useSettings } from "@/store/settings";
import { useStorage } from "@/store/storage";
import "./restartPrompt.css";

export function RestartPrompt() {
  const { t } = useTranslation();
  const { open, close } = useRestartPrompt();
  const pending = useStorage((state) => state.restartPending);
  const load = useStorage((state) => state.loadRestartPending);
  const showStatusBar = useSettings((state) => state.settings.showStatusBar);
  useEffect(() => {
    void load();
  }, [load]);
  const restart = () => {
    close();
    requestApplicationAction("restart");
  };
  return (
    <>
      {pending && !showStatusBar ? (
        <button className="restart-floating" type="button" onClick={restart}>
          <RefreshCw size={14} /> {t("restart.now")}
        </button>
      ) : null}
      <Dialog
        open={open && pending}
        title={t("restart.requiredTitle")}
        closeLabel={t("common.close")}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t("restart.later")}</Button>
            <Button variant="primary" onClick={restart}>
              {t("restart.now")}
            </Button>
          </>
        }
      >
        <p>{t("restart.requiredBody")}</p>
      </Dialog>
    </>
  );
}
