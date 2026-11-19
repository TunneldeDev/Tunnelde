import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { brandMark } from "@/lib/brand";
import { initializePanelWindow, type PanelWindowClient } from "@/lib/panels/windowClient";
import {
  createWindowViews,
  installWindowViews,
  useWindowViews,
  type WindowViewRecord,
} from "@/lib/panels/windowViews";
import { startSatelliteViews } from "@/lib/panels/windowSatellite";
import { usePanelWindows } from "@/store/panelWindows";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { WorkbenchPanel } from "@/components/layout/WorkbenchPanel";
import { ConnectionDetails } from "@/components/layout/ConnectionStatus";
import { ConnectionModelScope } from "@/lib/panels/connectionModel";
import type { ConnectionWindowModel } from "./panelReadModels";
import { applyAppearance, observeSystemAppearance } from "@/lib/prefs/appearance";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import { ToastHost } from "@/components/ui/overlay/Toast";
import { translateError } from "@/lib/api/errors";
import { loadStartupFonts } from "./startupFonts";
import "./satellite.css";

function ConnectionView({
  client,
  record,
  presented,
}: {
  client: PanelWindowClient;
  record: WindowViewRecord;
  presented: (model: ConnectionWindowModel) => void;
}) {
  const [model, setModel] = useState<ConnectionWindowModel | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false,
      queued = false,
      running = false;
    let unsubscribe: (() => void) | undefined;
    let settings = createDefaultSettings();
    const appearance = observeSystemAppearance(() => settings);
    const refresh = () => {
      if (disposed) return;
      queued = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (queued && !disposed) {
            queued = false;
            const request = record.staged
              ? { action: "stagedModel" as const, id: record.key }
              : record.lease
                ? { action: "readModel" as const, lease: record.lease }
                : null;
            if (!request) continue;
            const next = await client.control<ConnectionWindowModel | null>(request);
            if (disposed || !next) continue;
            // This data originates only from the coordinator's explicit private
            // projection. Do not hydrate writable main stores in a satellite.
            settings = { ...createDefaultSettings(), ...next.appearance };
            applyAppearance(settings);
            await i18n.changeLanguage(next.language);
            if (!disposed) setModel(next);
          }
        } catch (error) {
          if (!disposed) toast(translateError(error), "error");
        } finally {
          running = false;
        }
      })();
    };
    void client
      .subscribe(refresh)
      .then((stop) => {
        if (disposed) stop();
        else {
          unsubscribe = stop;
          refresh();
        }
      })
      .catch((error) => {
        if (!disposed) toast(translateError(error), "error");
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      appearance();
    };
  }, [client, record.key, record.staged, record.lease]);
  useEffect(() => {
    if (model) presented(model);
  }, [model, presented]);
  if (!model) return null; // Never mark staged-ready until a real model is rendered.
  return (
    <NativePanelView panelId={record.panelId}>
      <WorkbenchPanel view="connections" location="workspace" visible={!record.staged} showTitle>
        <ConnectionModelScope
          model={{
            ...model.connection,
            disconnectingSessionIds: [
              ...new Set([...model.connection.disconnectingSessionIds, ...pending]),
            ],
          }}
          disconnect={async (id) => {
            if (!record.lease || record.staged) return;
            setPending((items) => [...items, id]);
            try {
              await client.disconnect(record.lease, id);
            } catch (error) {
              toast(translateError(error), "error");
            } finally {
              setPending((items) => items.filter((item) => item !== id));
            }
          }}
        >
          <ConnectionDetails />
        </ConnectionModelScope>
      </WorkbenchPanel>
    </NativePanelView>
  );
}

/** Separate document entry: never run main resource bootstrap, persistence,
 * plugin background activation, task aggregation or autoconnect in a satellite. */
export function SatelliteApp() {
  const { t } = useTranslation();
  const [client, setClient] = useState<PanelWindowClient | null>(null);
  const [failed, setFailed] = useState(false);
  const [chrome, setChrome] = useState<{
    style: ConnectionWindowModel["appearance"]["titleBarStyle"];
    os: string;
  } | null>(null);
  const presented = useCallback((model: ConnectionWindowModel) => {
    setChrome((current) =>
      current?.style === model.appearance.titleBarStyle && current.os === model.platform
        ? current
        : { style: model.appearance.titleBarStyle, os: model.platform },
    );
  }, []);
  const shown = useRef(false);
  useEffect(() => {
    if (!client || !chrome || shown.current) return;
    let disposed = false;
    void loadStartupFonts()
      .then(() => {
        if (!disposed)
          return client.show().then(() => {
            shown.current = true;
          });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [client, chrome]);
  const entries = useWindowViews((s) => s.entries);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void initializePanelWindow()
      .then(async (current) => {
        if (disposed) {
          current.dispose();
          return;
        }
        const views = createWindowViews(current);
        const uninstall = installWindowViews(views);
        const session = startSatelliteViews(current, views, {
          receive: (snapshot) =>
            usePanelWindows.setState({ windowId: current.windowId, available: true, snapshot }),
          failure: (error) => {
            if (!disposed) {
              setFailed(true);
              toast(translateError(error), "error");
            }
          },
        });
        views.close = session.close;
        cleanup = () => {
          session.dispose();
          uninstall();
          current.dispose();
          usePanelWindows.setState({ available: false });
        };
        setClient(current);
        await session.ready;
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
    <div className="satellite-workbench">
      <WindowTitleBar style={chrome?.style ?? "system"} os={chrome?.os ?? ""} />
      {chrome?.style === "compact" && chrome.os === "macos" ? (
        <div
          className="satellite-workbench__native-dragbar"
          onMouseDown={(event) => {
            if (event.button === 0 && event.detail < 2)
              void getCurrentWindow()
                .startDragging()
                .catch(() => {});
          }}
          onDoubleClick={() => {
            void getCurrentWindow()
              .toggleMaximize()
              .catch(() => {});
          }}
        />
      ) : null}
      {!client || !entries.size ? (
        <div className="splash" role={failed ? "alert" : "status"}>
          <img src={brandMark} width={56} height={56} alt="Tunnelde" />
          {failed ? <span>{t("panels.windowInitializationFailed")}</span> : null}
        </div>
      ) : (
        [...entries.values()].map((record) => (
          <ConnectionView key={record.key} client={client} record={record} presented={presented} />
        ))
      )}
      <ToastHost />
    </div>
  );
}
