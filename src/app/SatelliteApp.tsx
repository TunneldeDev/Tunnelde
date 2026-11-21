import { NativeHostView, useNativeHostTitles } from "@/features/hosts/detail/NativeHostPage";
import { NativeEditorView, useNativeEditorTitles } from "@/features/editor/NativeEditorPage";
import { NativeFileView, useNativeFileTitles } from "@/features/sftp/NativeFilePage";
import { useNativeReadModel, type NativeViewProps } from "@/lib/panels/useNativeReadModel";
import {
  NativeTerminalView,
  useNativeTerminalTitles,
} from "@/features/terminal/NativeTerminalPage";
import { WindowPluginsSection } from "@/features/plugins/PluginsSection";
import type { PluginsWindowModel } from "./panelReadModels";
import { WindowHostsPanel } from "@/features/hosts/panel/WindowHostsPanel";
import type { HostsWindowModel } from "./panelReadModels";
import { NativePreviewContent } from "@/features/sftp/preview/NativePreviewContent";
import type { PreviewWindowModel } from "@/features/sftp/preview/windowPublication";
import "@/features/sftp/preview/previewPanel.css";
import { createWindowProviderOwner } from "@/lib/panels/windowProviderOwner";
import { useLayoutEffect } from "react";
import { NativePluginPanel } from "@/components/layout/NativePluginPanel";
import { DeclarativeNativeView } from "@/features/plugins/DeclarativeNativeView";
import { WindowForwardingPanel } from "@/features/forwarding/components/WindowForwardingPanel";
import { disconnectConnectionBatch } from "@/lib/session/connectionBatch";
import { startNativePluginUi } from "@/lib/panels/windowPluginUi";
import { ConfirmDialogHost } from "@/components/ui/overlay/ConfirmDialogHost";
import { startPresentationRequests } from "@/lib/panels/presentationRequests";
import { registerTaskPresentation } from "@/features/tasks/presentation";
import { TransferBackgroundTask } from "@/features/sftp/TransferBackgroundTask";
import { NativeSettingsView } from "@/features/settings/window/NativeSettingsPage";
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
  windowViews,
  installWindowViews,
  useWindowViews,
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
  ForwardingWindowModel,
  WindowModelAppearance,
} from "./panelReadModels";
import { TaskModelScope, type ClearTasksResult } from "@/lib/panels/taskModel";
import { DockedBackgroundTasks } from "@/features/tasks/BackgroundTasks";
import { toast } from "@/store/toasts";
import { ToastHost } from "@/components/ui/overlay/Toast";
import { translateError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { loadStartupFonts } from "./startupFonts";
import "./satellite.css";

function PluginView(props: NativeViewProps) {
  const model = useNativeReadModel<WindowModelAppearance>(props);
  if (!model || (!props.record.plugin && !props.record.declarative)) return null;
  return (
    <NativePanelView panelId={props.record.panelId}>
      <WorkbenchPanel
        view={props.record.panelId as SidebarView}
        location="workspace"
        visible={!props.record.staged}
      >
        {props.record.declarative ? (
          <DeclarativeNativeView
            client={props.client}
            record={props.record}
            visible={!props.record.staged}
          />
        ) : (
          <NativePluginPanel panelId={props.record.panelId} visible={!props.record.staged} />
        )}
      </WorkbenchPanel>
    </NativePanelView>
  );
}

function PluginsView(props: NativeViewProps) {
  const model = useNativeReadModel<PluginsWindowModel>(props);
  if (!model) return null;
  return (
    <NativePanelView panelId="plugins">
      <WorkbenchPanel view="plugins" location="workspace" visible={!props.record.staged}>
        <WindowPluginsSection data={model.plugins} />
      </WorkbenchPanel>
    </NativePanelView>
  );
}
function HostsView(props: NativeViewProps) {
  const model = useNativeReadModel<HostsWindowModel>(props);
  if (!model) return null;
  return (
    <NativePanelView panelId="hosts">
      <WorkbenchPanel view="hosts" location="workspace" visible={!props.record.staged}>
        <WindowHostsPanel client={props.client} record={props.record} data={model.hosts} />
      </WorkbenchPanel>
    </NativePanelView>
  );
}

function ConnectionView(props: NativeViewProps) {
  const { client, record } = props;
  const model = useNativeReadModel<ConnectionWindowModel>(props);
  const [pending, setPending] = useState<string[]>([]);
  if (!model) return null; // Never mark staged-ready until a real model is rendered.
  return (
    <NativePanelView panelId={record.panelId}>
      <WorkbenchPanel view="connections" location="workspace" visible={!record.staged}>
        <ConnectionModelScope
          model={{
            ...model.connection,
            disconnectingSessionIds: [
              ...new Set([...model.connection.disconnectingSessionIds, ...pending]),
            ],
          }}
          disconnectMany={(ids) =>
            disconnectConnectionBatch(ids, async (id) => {
              if (!record.lease || record.staged) throw new Error("panel.window.staleOwner");
              setPending((items) => [...items, id]);
              try {
                await client.action(record.lease, { kind: "disconnect", sessionId: id });
              } catch (error) {
                toast(translateError(error), "error");
                throw error;
              } finally {
                setPending((items) => items.filter((item) => item !== id));
              }
            })
          }
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
  const [provider] = useState(() => {
    const views = windowViews();
    return createWindowProviderOwner(client, record, {
      current: () =>
        windowViews() === views ? useWindowViews.getState().entries.get(record.panelId) : undefined,
      frozen: () => {
        const state = usePanelWindows.getState();
        return (
          !state.available ||
          state.windowId !== client.windowId ||
          state.snapshot.transfers.some(({ offer }) => offer.lease.panelId === record.panelId) ||
          !!state.snapshot.interruptions?.some((item) => item.panelId === record.panelId)
        );
      },
    });
  });
  const lease = record.staged ? undefined : record.lease;
  useLayoutEffect(() => provider.start(lease), [provider, lease]);
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
      <WorkbenchPanel view="tasks" location="workspace" visible={!record.staged}>
        <TaskModelScope
          value={{
            providerOwner: provider.owner,
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
      <WorkbenchPanel view="output" location="workspace" visible={!record.staged}>
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
      <WorkbenchPanel view="knownHosts" location="workspace" visible={!record.staged}>
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

function PreviewView(props: NativeViewProps) {
  const model = useNativeReadModel<PreviewWindowModel>(props);
  if (!model?.preview) return null;
  return (
    <NativePanelView panelId="filePreview">
      <WorkbenchPanel view="filePreview" location="workspace" visible={!props.record.staged}>
        <NativePreviewContent
          key={props.record.key}
          client={props.client}
          record={props.record}
          data={model.preview}
        />
      </WorkbenchPanel>
    </NativePanelView>
  );
}

function ForwardingView(props: NativeViewProps) {
  const model = useNativeReadModel<ForwardingWindowModel>(props);
  if (!model) return null;
  return (
    <NativePanelView panelId={props.record.panelId}>
      <WorkbenchPanel view="forwarding" location="workspace" visible={!props.record.staged}>
        <WindowForwardingPanel
          key={props.record.key}
          client={props.client}
          record={props.record}
          data={model.forwarding}
        />
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
      .catch((error) => {
        reportError("panels.windows", "satellite.initialize", error);
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [client, chrome]);
  const terminalTitles = useNativeTerminalTitles((state) => state.titles);
  const hostTitles = useNativeHostTitles((s) => s.titles);
  const fileTitles = useNativeFileTitles((state) => state.titles);
  const editorTitles = useNativeEditorTitles((state) => state.titles);
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
            reportError("panels.windows", "satellite.session", error);
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
        const stopUi = startNativePluginUi(current, (error) =>
          reportError("panels.windows", "pluginUi", error),
        );
        const stopDrag = installPanelWindowDrag(current, (error) =>
          toast(translateError(error), "error"),
        );
        cleanup = () => {
          stopUi();
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
      .catch((error) => {
        reportError("panels.windows", "satellite.initialize", error);
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
            id: record.panelId,
            title: record.panelId.startsWith("settings-view:")
              ? t("settings.title")
              : record.panelId.startsWith("editor-view:")
                ? editorTitles[record.panelId]
                : record.panelId.startsWith("host-view:")
                  ? hostTitles[record.panelId]
                  : record.panelId.startsWith("files:") || record.panelId.startsWith("sftp:")
                    ? fileTitles[record.panelId]
                    : record.panelId.startsWith("terminal:")
                      ? (terminalTitles[record.panelId] ?? "Terminal")
                      : undefined,
            key: record.key,
            content: record.panelId.startsWith("settings-view:") ? (
              <NativeSettingsView client={client} record={record} presented={presented} />
            ) : record.panelId.startsWith("editor-view:") ? (
              <NativeEditorView client={client} record={record} presented={presented} />
            ) : record.panelId.startsWith("host-view:") ? (
              <NativeHostView client={client} record={record} presented={presented} />
            ) : record.panelId.startsWith("files:") || record.panelId.startsWith("sftp:") ? (
              <NativeFileView client={client} record={record} presented={presented} />
            ) : record.panelId.startsWith("terminal:") ? (
              <NativeTerminalView client={client} record={record} presented={presented} />
            ) : record.panelId === "plugins" ? (
              <PluginsView client={client} record={record} presented={presented} />
            ) : record.panelId === "hosts" ? (
              <HostsView client={client} record={record} presented={presented} />
            ) : record.panelId === "filePreview" ? (
              <PreviewView client={client} record={record} presented={presented} />
            ) : record.panelId === "knownHosts" ? (
              <KnownHostsView client={client} record={record} presented={presented} />
            ) : record.panelId === "tasks" ? (
              <TaskView client={client} record={record} presented={presented} />
            ) : record.panelId === "output" ? (
              <OutputView client={client} record={record} presented={presented} />
            ) : record.panelId === "forwarding" ? (
              <ForwardingView client={client} record={record} presented={presented} />
            ) : record.panelId === "connections" ? (
              <ConnectionView client={client} record={record} presented={presented} />
            ) : record.plugin || record.declarative ? (
              <PluginView client={client} record={record} presented={presented} />
            ) : null,
          }))}
        />
      )}
      <ContextMenuHost />
      <ToastHost />
      <ConfirmDialogHost />
    </div>
  );
}
