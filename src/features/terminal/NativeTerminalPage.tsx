import type { TerminalViewServices } from "./terminalViewServices";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { create, useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { GripVertical, RotateCcw, X } from "lucide-react";
import { TerminalPage, TerminalPageView } from "./TerminalPage";
import { TerminalSurface } from "./TerminalSurface";
import { createTerminalViewBinding } from "./terminalViewBinding";
import type { TerminalWindowModel } from "./terminalWindowModel";
import { useNativeReadModel, type NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { useWindowViews, windowViews } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { PanelFrame } from "@/components/layout/PanelFrame";
import { useLocalPanelScope, type LocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { localPanelMoveActions } from "@/lib/panels/localWorkspaceActions";
import { nativePanelMoveActions, movePanelToWindow } from "@/lib/panels/windowMoves";
import { endLocalPanelDrag, startLocalPanelDrag } from "@/lib/panels/localPanelDrag";
import { IconButton } from "@/components/ui/form/Button";
import { Menu } from "@/components/ui/overlay/Menu";
import { isTauri } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

export const useNativeTerminalTitles = create<{ titles: Record<string, string> }>(() => ({
  titles: {},
}));
const silentPresentation = () => {};
const BuiltinSurface: NonNullable<TerminalViewServices["Surface"]> = ({ children }) => (
  <>{children}</>
);

/** Main waits for its native binding BEFORE the first terminal attach. Rendering
 * a legacy PTY and later remounting it here would lose its already-rendered screen. */
export function MainNativeTerminalPage({
  sessionId,
  active,
}: {
  sessionId: string;
  active: boolean;
}) {
  const available = usePanelWindows((state) => state.available);
  const record = useWindowViews((state) => state.entries.get(`terminal:${sessionId}`));
  const client = windowViews()?.client;
  if (!isTauri()) return <TerminalPage sessionId={sessionId} active={active} />;
  if (!available || !client) return <div role="status" aria-busy="true" />;
  if (!record)
    return (
      <NativePanelView panelId={`terminal:${sessionId}`}>
        <div role="status" aria-busy="true" />
      </NativePanelView>
    );
  return (
    <NativeTerminalView
      client={client}
      record={record}
      presented={silentPresentation}
      active={active}
    />
  );
}
function LocalFrame({
  scope,
  title,
  children,
}: {
  scope: LocalPanelScope;
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const bounds = useStore(scope.floating, (state) => state.bounds);
  const close = () => {
    void movePanelToWindow(scope.panelId, "main").catch((error) =>
      toast(translateError(error), "error"),
    );
  };
  return (
    <PanelFrame
      label={title}
      panelId={scope.panelId}
      floating={scope.location === "floating"}
      location={scope.location}
      bounds={bounds}
      onBounds={scope.floating.getState().setBounds}
      onEscape={close}
      header={(geometry) =>
        scope.location !== "floating" ? null : (
          <header className="workbench-panel__head" role="toolbar" aria-label={title}>
            <button
              type="button"
              className="workbench-panel__drag"
              title={t("panels.moveHint")}
              {...geometry.handle("move")}
              onDoubleClick={geometry.reset}
            >
              <span
                draggable
                data-panel-drag-handle
                className="workbench-panel__dock-grip"
                onPointerDown={(event) => event.stopPropagation()}
                onDragStart={(event) =>
                  startLocalPanelDrag(scope.workspace, scope.panelId, event.dataTransfer)
                }
                onDragEnd={endLocalPanelDrag}
              >
                <GripVertical size={12} />
              </span>
              <strong>{title}</strong>
            </button>
            <Menu
              label={t("common.more")}
              items={[
                ...nativePanelMoveActions(scope.panelId, t),
                ...localPanelMoveActions(scope.workspace, scope.panelId, t),
              ]}
            />
            <IconButton size="sm" label={t("panels.resetLayout")} onClick={geometry.reset}>
              <RotateCcw size={13} />
            </IconButton>
            <IconButton size="sm" label={t("common.close")} onClick={close}>
              <X size={14} />
            </IconButton>
          </header>
        )
      }
    >
      {children}
    </PanelFrame>
  );
}
function TerminalRenderer({
  client,
  record,
  model,
  active,
}: NativeViewProps & { model: TerminalWindowModel; active: boolean }) {
  const [binding] = useState(() => createTerminalViewBinding(client, record, model));
  useLayoutEffect(() => {
    binding.mount();
    return () => binding.dispose();
  }, [binding]);
  useLayoutEffect(() => {
    binding.update(model);
    binding.activate(record.staged ? undefined : record.lease);
  }, [binding, model, record]);
  const Surface = client.windowId === "main" ? TerminalSurface : BuiltinSurface;
  return (
    <TerminalPageView
      sessionId={model.terminal.session.id}
      active={active && !record.staged}
      services={{
        ...binding.services,
        session: model.terminal.session,
        disconnecting: model.terminal.disconnecting,
        closed: model.terminal.closed,
        staged: record.staged,
        Surface,
      }}
    />
  );
}
export function NativeTerminalView(props: NativeViewProps & { active?: boolean }) {
  const { t } = useTranslation();
  const local = useLocalPanelScope();
  const model = useNativeReadModel<TerminalWindowModel>(props);
  useEffect(() => {
    if (!model) return;
    useNativeTerminalTitles.setState((state) =>
      state.titles[props.record.panelId] === model.terminal.session.title
        ? state
        : { titles: { ...state.titles, [props.record.panelId]: model.terminal.session.title } },
    );
  }, [model, props.record.panelId]);
  if (!model) return <div role="status" aria-busy="true" />;
  const content = (
    <>
      {props.client.windowId !== "main" && model.terminal.providerSelected ? (
        <div className="native-panel-interruption" role="status">
          {t("plugin.frontend.viewUnavailable")}
          <button
            type="button"
            onClick={() => {
              void movePanelToWindow(props.record.panelId, "main").catch((error) =>
                toast(translateError(error), "error"),
              );
            }}
          >
            {t("panels.returnToMainWindow")}
          </button>
        </div>
      ) : null}
      <TerminalRenderer {...props} model={model} active={props.active ?? local?.visible ?? true} />
    </>
  );
  return (
    <NativePanelView panelId={props.record.panelId}>
      {local ? (
        <LocalFrame scope={local} title={model.terminal.session.title}>
          {content}
        </LocalFrame>
      ) : (
        content
      )}
    </NativePanelView>
  );
}
