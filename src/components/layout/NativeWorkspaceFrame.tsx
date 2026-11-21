import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { GripVertical, RotateCcw, X } from "lucide-react";
import { PanelFrame } from "./PanelFrame";
import type { LocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { localPanelMoveActions } from "@/lib/panels/localWorkspaceActions";
import { nativePanelMoveActions, movePanelToWindow } from "@/lib/panels/windowMoves";
import { endLocalPanelDrag, startLocalPanelDrag } from "@/lib/panels/localPanelDrag";
import { IconButton } from "@/components/ui/form/Button";
import { Menu } from "@/components/ui/overlay/Menu";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
export function NativeWorkspaceFrame({
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
