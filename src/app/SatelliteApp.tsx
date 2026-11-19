import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { brandMark } from "@/lib/brand";
import { initializePanelWindow } from "@/lib/panels/windowClient";

/** A separate document entry is essential: never run the main resource
 * bootstrap/persistence/autoconnect/task aggregation in a second WebView. The
 * coordinator stages views here before granting ownership. */
export function SatelliteApp() {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void initializePanelWindow()
      .then(async (client) => {
        if (disposed) {
          client.dispose();
          return;
        }
        cleanup = () => client.dispose();
        await client.onClose(() => {
          void client
            .snapshot()
            .then((snapshot) => {
              if (!snapshot.panels.some((panel) => panel.windowId === client.windowId))
                return client.destroy(client.windowId);
            })
            .catch(() => {
              if (!disposed) setFailed(true);
            });
        });
        // Do not acknowledge readiness yet. Until its owned-content/read-model
        // adapter is attached this shell must not accept transfers from a source.
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  return (
    <div className="splash" role={failed ? "alert" : "status"}>
      <img src={brandMark} width={56} height={56} alt="Tunnelde" />
      {failed ? <span>{t("panels.windowInitializationFailed")}</span> : null}
    </div>
  );
}
