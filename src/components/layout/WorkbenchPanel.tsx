import { useStore } from "zustand";
import { useLocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { usePanelWindows } from "@/store/panelWindows";
import { movePanelToWindow } from "@/lib/panels/windowMoves";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { GripVertical, Pin, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { HelpPresentationProvider } from "@/components/ui/form/HelpHint";
import { useFloatingPanel } from "./useFloatingPanel";
import { panelActionsContainer } from "./panelSlots";
import { SidebarDockControls, SidebarTitle } from "./SidebarDockControls";
import { sidebarLabel, SIDEBAR_MIME, sidebarTabId, TAB_MIME } from "@/lib/session/sidebarDock";
import { panelPresentation } from "@/store/panelPresentation";
import type { SidebarView } from "@/store/navigation";
import { restorePanelFocus } from "@/lib/panels/focus";
import { closePanel, type PanelPresentation } from "@/lib/panels/controller";
import "./workbenchPanel.css";

const PanelScope = createContext<{
  view: SidebarView;
  location: PanelPresentation;
  visible: boolean;
} | null>(null);
export function useWorkbenchPanel() {
  return useContext(PanelScope);
}

/** Optional feature header; the integrated panel relocates its actions into shared chrome. */
export function PanelHeader({
  view,
  children,
  managed = false,
}: {
  view: SidebarView;
  children?: ReactNode;
  managed?: boolean;
}) {
  const scope = useWorkbenchPanel();
  const { t } = useTranslation();
  if (managed || scope?.view === view)
    return children ? createPortal(children, panelActionsContainer(view)) : null;
  return (
    <header className="sidebar__head" role="toolbar" aria-label={sidebarLabel(view, t)}>
      <SidebarTitle view={view}>{sidebarLabel(view, t)}</SidebarTitle>
      {children}
      <SidebarDockControls view={view} />
    </header>
  );
}

/** Default integrated panel. Content has one retained owner regardless of presentation. */
export function WorkbenchPanel({
  view,
  location: requestedLocation,
  visible: requestedVisible,
  showTitle = false,
  children,
}: {
  view: SidebarView;
  location: PanelPresentation;
  visible: boolean;
  showTitle?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const local = useLocalPanelScope();
  const location = local?.location ?? requestedLocation;
  const visible = requestedVisible && (local?.visible ?? true);
  const windowId = usePanelWindows((state) => state.windowId);
  const close = () => {
    if (windowId === "main") closePanel(view);
    else {
      void movePanelToWindow(view, "main").catch((error) => toast(translateError(error), "error"));
    }
  };
  const store = local?.floating ?? panelPresentation(view);
  const pinned = useStore(store, (state) => state.pinned);
  const bounds = useStore(store, (state) => state.bounds);
  const panel = useRef<HTMLElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const floating = useFloatingPanel(
    panel,
    location === "floating" ? bounds : null,
    store.getState().setBounds,
  );
  const focusBeforeOpen = useRef<HTMLElement | null>(null);
  const scope = useMemo(() => ({ view, location, visible }), [view, location, visible]);
  useLayoutEffect(() => {
    actions.current?.append(panelActionsContainer(view));
  }, [view]);
  useEffect(() => {
    const restored = restorePanelFocus(view);
    if (!visible || location !== "floating") return;
    const currentPanel = panel.current;
    focusBeforeOpen.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!restored) closeButton.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (
        (!active || active === document.body || currentPanel?.contains(active)) &&
        focusBeforeOpen.current?.isConnected
      )
        focusBeforeOpen.current.focus({ preventScroll: true });
    };
  }, [view, visible, location]);
  useEffect(() => {
    if (!visible || location !== "floating" || pinned) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || panel.current?.contains(event.target)) return;
      if (event.target.closest("[data-panel-trigger]")?.getAttribute("data-panel-trigger") === view)
        return;
      if (
        event.target.closest(
          '[role="dialog"][aria-modal="true"], .context-menu, .td-menu, .td-tooltip',
        )
      )
        return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (windowId === "main") store.getState().close();
      else
        void movePanelToWindow(view, "main").catch((error) =>
          toast(translateError(error), "error"),
        );
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [visible, location, pinned, store, view, windowId]);
  return (
    <PanelScope.Provider value={scope}>
      <HelpPresentationProvider value="tooltip">
        <section
          ref={panel}
          className={`workbench-panel is-${location}${location === "floating" ? " workbench-panel--floating" : ""}`}
          data-workbench-panel={view}
          role={location === "floating" ? "dialog" : "region"}
          aria-modal={location === "floating" ? "false" : undefined}
          aria-label={sidebarLabel(view, t)}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.key !== "Escape" ||
              location !== "floating"
            )
              return;
            if (
              document.querySelector(
                '[role="dialog"][aria-modal="true"], .td-menu, .context-menu, .td-tooltip',
              )
            )
              return;
            event.stopPropagation();
            close();
          }}
        >
          <header
            className="workbench-panel__head"
            role="toolbar"
            aria-label={sidebarLabel(view, t)}
          >
            {location === "floating" ? (
              <button
                type="button"
                className="workbench-panel__drag"
                title={t("panels.moveHint")}
                {...floating.handle("move")}
                onDoubleClick={floating.reset}
              >
                <span
                  draggable
                  className="workbench-panel__dock-grip"
                  title={t("docking.dragHint")}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(TAB_MIME, sidebarTabId(view));
                    event.dataTransfer.setData(SIDEBAR_MIME, view);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <GripVertical size={12} />
                </span>
                <strong>{sidebarLabel(view, t)}</strong>
              </button>
            ) : location === "sidebar" || (showTitle && !local) ? (
              <SidebarTitle view={view}>{sidebarLabel(view, t)}</SidebarTitle>
            ) : (
              <span className="workbench-panel__spacer" />
            )}
            <div ref={actions} className="workbench-panel__action-slot" />
            <SidebarDockControls view={view} />
            {location === "floating" ? (
              <>
                <IconButton size="sm" label={t("panels.resetLayout")} onClick={floating.reset}>
                  <RotateCcw size={13} />
                </IconButton>
                <IconButton
                  size="sm"
                  label={t("panels.keepOpen")}
                  active={pinned}
                  onClick={store.getState().togglePinned}
                >
                  <Pin size={13} />
                </IconButton>
              </>
            ) : null}
            <IconButton size="sm" ref={closeButton} label={t("common.close")} onClick={close}>
              <X size={14} />
            </IconButton>
          </header>
          <div className="workbench-panel__body">{children}</div>
          {location === "floating" &&
            (["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const).map((edge) => (
              <div
                key={edge}
                className={`workbench-panel__resize workbench-panel__resize--${edge}`}
                {...floating.handle(edge)}
                {...(edge === "se"
                  ? { role: "button", tabIndex: 0, "aria-label": t("panels.resizeHint") }
                  : { "aria-hidden": true })}
              />
            ))}
        </section>
      </HelpPresentationProvider>
    </PanelScope.Provider>
  );
}
