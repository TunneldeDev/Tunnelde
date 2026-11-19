import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PanelLayout } from "@/components/ui/layout/PanelLayout";
import { Menu } from "@/components/ui/overlay/Menu";
import { createLocalPanelWorkspace, type LocalPanelWorkspace } from "@/lib/panels/localWorkspace";
import { LocalPanelScopeProvider } from "@/lib/panels/localWorkspaceScope";
import { localPanelMoveActions } from "@/lib/panels/localWorkspaceActions";
import { nativePanelMoveActions, movePanelToWindow } from "@/lib/panels/windowMoves";
import { sidebarLabel } from "@/lib/session/sidebarDock";
import type { SidebarView } from "@/store/navigation";
import type { FloatingPanelState } from "@/store/panelPresentation";
import { isFloatingRect } from "@/lib/layout/floatingPanel";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import "./panelWorkspace.css";
import "./tabBar.css";

export interface PanelWorkspaceEntry {
  id: SidebarView;
  key: string;
  content: ReactNode;
}
function createSlot(id: string) {
  const element = document.createElement("div");
  element.className = "panel-workspace__content";
  element.dataset.panelSlot = id;
  const floating = createStore<FloatingPanelState>((set) => ({
    preferred: null,
    open: false,
    pinned: true,
    bounds: null,
    order: 0,
    setPreferred: (preferred) => set({ preferred }),
    setBounds: (bounds) => {
      if (!bounds || isFloatingRect(bounds)) set({ bounds });
    },
    show: () => set({ open: true }),
    close: () => set({ open: false }),
    toggle: () => set((state) => ({ open: !state.open })),
    togglePinned: () => set((state) => ({ pinned: !state.pinned })),
    raise: () => {}, // Local workspace owns stack order, not persistent main UI state.
  }));
  return { element, floating };
}
type Slot = ReturnType<typeof createSlot>;
function Mount({ slot }: { slot: Slot }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const active =
      document.activeElement instanceof HTMLElement && slot.element.contains(document.activeElement)
        ? document.activeElement
        : null;
    root.current?.append(slot.element);
    active?.focus({ preventScroll: true });
  }, [slot]);
  return <div className="panel-workspace__mount" ref={root} />;
}
const close = (id: string) => {
  void movePanelToWindow(id, "main").catch((error) => toast(translateError(error), "error"));
};
function Group({
  id,
  workspace,
  slots,
}: {
  id: string;
  workspace: LocalPanelWorkspace;
  slots: ReadonlyMap<string, Slot>;
}) {
  const { t } = useTranslation();
  const group = useStore(workspace.store, (state) => state.groups.find((group) => group.id === id));
  const strip = useRef<HTMLDivElement>(null);
  if (!group) return null;
  const select = (panel: string) => {
    workspace.activate(panel);
    [...(strip.current?.querySelectorAll<HTMLElement>("[data-local-tab]") ?? [])]
      .find((element) => element.dataset.localTab === panel)
      ?.focus({ preventScroll: true });
  };
  return (
    <section className="panel-workspace__group" data-local-group={id}>
      <div className="pane__header">
        <div className="pane__tabs" role="tablist" ref={strip}>
          {group.panels.map((panel) => (
            <div
              key={panel}
              role="tab"
              data-local-tab={panel}
              className={`td-tab${group.active === panel ? " is-active" : ""}`}
              tabIndex={group.active === panel ? 0 : -1}
              aria-selected={group.active === panel}
              aria-controls={`local-panel-${panel}`}
              id={`local-tab-${panel}`}
              onClick={() => select(panel)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                const index = group.panels.indexOf(panel);
                const next =
                  event.key === "ArrowRight"
                    ? group.panels[(index + 1) % group.panels.length]
                    : event.key === "ArrowLeft"
                      ? group.panels[(index - 1 + group.panels.length) % group.panels.length]
                      : event.key === "Home"
                        ? group.panels[0]
                        : event.key === "End"
                          ? group.panels.at(-1)
                          : undefined;
                if (next) {
                  event.preventDefault();
                  select(next);
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(panel);
                }
              }}
            >
              <span className="td-tab__label">{sidebarLabel(panel as SidebarView, t)}</span>
              <button
                type="button"
                className="td-tab__close"
                aria-label={t("common.close")}
                onClick={(event) => {
                  event.stopPropagation();
                  close(panel);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="pane__actions">
          <Menu
            label={t("common.more")}
            items={[
              ...nativePanelMoveActions(group.active, t),
              ...localPanelMoveActions(workspace, group.active, t),
            ]}
          />
        </div>
      </div>
      <div className="panel-workspace__group-body">
        {group.panels.map((panel) => {
          const slot = slots.get(panel);
          return slot ? (
            <div
              key={panel}
              hidden={group.active !== panel}
              className="panel-workspace__page"
              role="tabpanel"
              id={`local-panel-${panel}`}
              aria-labelledby={`local-tab-${panel}`}
            >
              <Mount slot={slot} />
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}

/** Shared document-local panel workspace: tabs, split geometry and floating
 * presentations compose existing primitives. Each portal owner stays mounted
 * while its DOM slot moves, preserving drafts, selection and resource lifetimes. */
export function PanelWorkspace({ entries }: { entries: readonly PanelWorkspaceEntry[] }) {
  const { t } = useTranslation();
  const [workspace] = useState(createLocalPanelWorkspace);
  const state = useStore(workspace.store);
  const [slots] = useState(() => new Map<string, Slot>());
  const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);
  useLayoutEffect(() => {
    for (const id of ids) if (!slots.has(id)) slots.set(id, createSlot(id));
    workspace.reconcile(ids);
    for (const [id, slot] of slots)
      if (!ids.includes(id as SidebarView)) {
        slot.element.remove();
        slots.delete(id);
      }
  }, [ids, workspace, slots]);
  return (
    <div className="panel-workspace">
      <div className="panel-workspace__docked">
        {state.layout ? (
          <PanelLayout
            layout={state.layout}
            renderPane={(id) => <Group id={id} workspace={workspace} slots={slots} />}
            onResize={(id, ratio) => workspace.resize({ [id]: ratio })}
            onResizeMany={workspace.resize}
            resizeLabel={t("tab.resizeGroup")}
          />
        ) : null}
      </div>
      <div className="workbench-floating-layer">
        {state.floating.map((id, index) => {
          const slot = slots.get(id);
          return slot ? (
            <div
              className="workbench-floating-slot"
              key={id}
              style={{ zIndex: index + 1 }}
              onPointerDownCapture={() => workspace.activate(id)}
            >
              <Mount slot={slot} />
            </div>
          ) : null;
        })}
      </div>
      {entries.map((entry) => {
        const slot = slots.get(entry.id);
        if (!slot) return null;
        const floating = state.floating.includes(entry.id),
          group = state.groups.find((group) => group.panels.includes(entry.id));
        if (!floating && !group) return null;
        return createPortal(
          <LocalPanelScopeProvider
            value={{
              workspace,
              panelId: entry.id,
              floating: slot.floating,
              location: floating ? "floating" : "workspace",
              visible: floating || group?.active === entry.id,
            }}
          >
            {entry.content}
          </LocalPanelScopeProvider>,
          slot.element,
          `${entry.id}:${entry.key}`,
        );
      })}
    </div>
  );
}
