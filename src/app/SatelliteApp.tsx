import { startPresentationRequests } from "@/lib/panels/presentationRequests";
import { registerTaskPresentation } from "@/features/tasks/presentation";
import { TransferBackgroundTask } from "@/features/sftp/TransferBackgroundTask";
import { KnownHostsList } from "@/features/settings/KnownHostsList";
import { KnownHostsModelScope } from "@/lib/panels/knownHostsModel";
import type { PanelViewAction } from "@/lib/panels/windowProtocol";
import { OutputPanel } from "@/features/output/OutputPanel";
import { OutputModelScope } from "@/lib/panels/outputModel";
import { installPanelWindowDrag } from "@/lib/panels/windowDrag";
import { useInternalDrag } from "@/lib/session/useInternalDrag";
import { PanelWorkspace } from "@/components/layout/PanelWorkspace";
import { ContextMenuHost } from "@/components/ui/overlay/ContextMenu";
import type { SidebarView } from "@/store/navigation";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { brandMark } from "@/lib/brand";
import { initializePanelWindow, type PanelWindowClient } from "@/lib/panels/windowClient";
import {
  createWindowViews,
  installWindowViews,
  useWindowViews,
  type WindowViewRecord,
} from "@/lib/panels/windowViews";
import { startSourcePanelFocus } from "@/lib/panels/sourcePresentation";
import { startPanelMoveRequests } from "@/lib/panels/windowMoveRequests";
import { startSatelliteViews } from "@/lib/panels/windowSatellite";
import { usePanelWindows } from "@/store/panelWindows";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { WorkbenchPanel } from "@/components/layout/WorkbenchPanel";
import { ConnectionDetails } from "@/components/layout/ConnectionStatus";
import { ConnectionModelScope } from "@/lib/panels/connectionModel";
import type {
  ConnectionWindowModel,
  TaskWindowModel,
  OutputWindowModel,
  KnownHostsWindowModel,
  WindowModelAppearance,
} from "./panelReadModels";
import { TaskModelScope, type ClearTasksResult } from "@/lib/panels/taskModel";
import { DockedBackgroundTasks } from "@/features/tasks/BackgroundTasks";
import { applyAppearance, observeSystemAppearance } from "@/lib/prefs/appearance";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import { ToastHost } from "@/components/ui/overlay/Toast";
import { translateError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { loadStartupFonts } from "./startupFonts";
import "./satellite.css";

interface NativeViewProps {
  client: PanelWindowClient;
  record: WindowViewRecord;
  presented: (model: WindowModelAppearance) => void;
}
function useNativeReadModel<T extends WindowModelAppearance>({
  client,
  record,
  presented,
}: NativeViewProps) {
  const [model, setModel] = useState<T | null>(null);
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
            const next = await client.control<T | null>(request);
            if (disposed || !next) continue;
            // This data originates only from the coordinator's explicit private
            // projection. Do not hydrate writable main stores in a satellite.
            settings = { ...createDefaultSettings(), ...next.appearance };
            applyAppearance(settings);
            // Native action notifications also refresh models. Re-emitting an
            // unchanged language replaces react-i18next's t function and can
            // restart feature effects (e.g. a pending host-key probe) forever.
            if ((i18n.resolvedLanguage ?? i18n.language) !== next.language)
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
  return model;
}
function ConnectionView(props: NativeViewProps) {
  const { client, record } = props;
  const model = useNativeReadModel<ConnectionWindowModel>(props);
  const [pending, setPending] = useState<string[]>([]);
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
              await client.action(record.lease, { kind: "disconnect", sessionId: id });
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

function TaskView(props: NativeViewProps) {
  const { client, record } = props;
  const model = useNativeReadModel<TaskWindowModel>(props);
  const items = useMemo(
    () =>
      model?.tasks.map((task) => ({
        ...task,
        actions: task.actions.map((action) => ({ ...action, run: () => {} })),
      })) ?? [],
    [model],
  );
  if (!model) return null;
  return (
    <NativePanelView panelId={record.panelId}>
      <WorkbenchPanel view="tasks" location="workspace" visible={!record.staged} showTitle>
        <TaskModelScope
          value={{
            items,
            transfers: {
              entries: model.tasks,
              action: (request) => {
                if (!record.lease || record.staged)
                  return Promise.reject(new Error("panel.window.staleOwner"));
                return client.action(record.lease, request);
              },
            },
            viewKey: (task) => model.tasks.find((entry) => entry.key === task.key)!.ticket,
            run: async (task, actionId) => {
              if (!record.lease || record.staged) throw new Error("panel.window.staleOwner");
              return client.action(record.lease, {
                kind: "task",
                key: task.key,
                ticket: model.tasks.find((entry) => entry.key === task.key)!.ticket,
                actionId,
              });
            },
            clear: async () => {
              if (!record.lease || record.staged) throw new Error("panel.window.staleOwner");
              return client.action<ClearTasksResult>(record.lease, { kind: "clearTasks" });
            },
          }}
        >
          <DockedBackgroundTasks />
        </TaskModelScope>
      </WorkbenchPanel>
    </NativePanelView>
  );
}

function OutputView(props: NativeViewProps) {
  const { client, record } = props;
  const model = useNativeReadModel<OutputWindowModel>(props);
  if (!model) return null;
  const action = (request: PanelViewAction) => {
    if (!record.lease || record.staged) return Promise.reject(new Error("panel.window.staleOwner"));
    return client.action(record.lease, request);
  };
  return (
    <NativePanelView panelId={record.panelId}>
      <WorkbenchPanel view="output" location="workspace" visible={!record.staged} showTitle>
        <OutputModelScope
          value={{
            ...model.output,
            refresh: () => action({ kind: "output", operation: "refresh" }),
            clear: () => action({ kind: "output", operation: "clear" }),
            copy: (text) => action({ kind: "copyOutput", text }),
            openLatest: () => action({ kind: "output", operation: "openLatest" }),
            openDirectory: () => action({ kind: "output", operation: "openDirectory" }),
          }}
        >
          <OutputPanel active={!record.staged} />
        </OutputModelScope>
      </WorkbenchPanel>
    </NativePanelView>
  );
}

function KnownHostsView(props: NativeViewProps) {
  const { client, record } = props;
  const model = useNativeReadModel<KnownHostsWindowModel>(props);
  if (!model) return null;
  const action = (request: PanelViewAction) => {
    if (!record.lease || record.staged) return Promise.reject(new Error("panel.window.staleOwner"));
    return client.action(record.lease, request);
  };
  return (
    <NativePanelView panelId={record.panelId}>
      <WorkbenchPanel view="knownHosts" location="workspace" visible={!record.staged} showTitle>
        <KnownHostsModelScope
          value={{
            ...model.knownHosts,
            refresh: () => action({ kind: "refreshKnownHosts" }),
            forget: (entry) => action({ kind: "forgetKnownHost", entry }),
          }}
        >
          <KnownHostsList active={!record.staged} variant="sidebar" />
        </KnownHostsModelScope>
      </WorkbenchPanel>
    </NativePanelView>
  );
}

/** Separate document entry: never run main resource bootstrap, persistence,
 * plugin background activation, task aggregation or autoconnect in a satellite. */
export function SatelliteApp() {
  useEffect(() => registerTaskPresentation("transfers", TransferBackgroundTask), []);
  useInternalDrag();
  const { t } = useTranslation();
  const [client, setClient] = useState<PanelWindowClient | null>(null);
  const [failed, setFailed] = useState(false);
  const [chrome, setChrome] = useState<{
    style: ConnectionWindowModel["appearance"]["titleBarStyle"];
    os: string;
  } | null>(null);
  const presented = useCallback((model: WindowModelAppearance) => {
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
        const stopMoves = startPanelMoveRequests(current, (error) =>
          reportError("panels.windows", "pluginMove", error),
        );
        const stopPresentation = startPresentationRequests(current, (error) =>
          reportError("panels.windows", "presentation", error),
        );
        const stopFocus = startSourcePanelFocus(current, (error) =>
          reportError("panels.windows", "focus", error),
        );
        const stopDrag = installPanelWindowDrag(current, (error) =>
          toast(translateError(error), "error"),
        );
        cleanup = () => {
          stopMoves();
          stopPresentation();
          stopFocus();
          stopDrag();
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
        <PanelWorkspace
          windowId={client.windowId}
          entries={[...entries.values()].map((record) => ({
            id: record.panelId as SidebarView,
            key: record.key,
            content:
              record.panelId === "knownHosts" ? (
                <KnownHostsView client={client} record={record} presented={presented} />
              ) : record.panelId === "tasks" ? (
                <TaskView client={client} record={record} presented={presented} />
              ) : record.panelId === "output" ? (
                <OutputView client={client} record={record} presented={presented} />
              ) : (
                <ConnectionView client={client} record={record} presented={presented} />
              ),
          }))}
        />
      )}
      <ContextMenuHost />
      <ToastHost />
    </div>
  );
}
