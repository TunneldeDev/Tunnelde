import { useLayoutEffect, useRef } from "react";

export type WorkbenchSurface = "workspace" | "navigation" | "inspector" | "statusbar";

/** The portal owner is outside the provider tree. Mounts move its DOM, never its React owner. */
export function createWorkbenchSurfaces() {
  const containers = new Map<WorkbenchSurface, HTMLDivElement>();
  const mounts = new Map<WorkbenchSurface, HTMLElement>();
  const focused = new Map<WorkbenchSurface, HTMLElement>();
  const listeners = new Set<() => void>();
  let scheduled = false;
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const receive of listeners) receive();
    });
  };
  const container = (name: WorkbenchSurface) => {
    let element = containers.get(name);
    if (!element) {
      element = document.createElement("div");
      element.style.display = "contents";
      element.dataset.workbenchSurface = name;
      containers.set(name, element);
    }
    return element;
  };
  function Mount({ name }: { name: WorkbenchSurface }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const target = ref.current!;
      if (mounts.has(name)) throw new Error(`plugin.frontend.duplicateSurface:${name}`);
      mounts.set(name, target);
      target.append(container(name));
      const focus = focused.get(name);
      if (focus && container(name).contains(focus)) focus.focus({ preventScroll: true });
      focused.delete(name);
      changed();
      return () => {
        if (
          document.activeElement instanceof HTMLElement &&
          container(name).contains(document.activeElement)
        )
          focused.set(name, document.activeElement);
        if (mounts.get(name) === target) mounts.delete(name);
        changed();
      };
    }, [name]);
    return <div ref={ref} style={{ display: "contents" }} />;
  }
  const Workspace = () => <Mount name="workspace" />;
  const Navigation = () => <Mount name="navigation" />;
  const Inspector = () => <Mount name="inspector" />;
  const StatusBar = () => <Mount name="statusbar" />;
  return {
    container,
    slots: Object.freeze({ Workspace, Navigation, Inspector, StatusBar }),
    hasWorkspace: () => !!containers.get("workspace")?.isConnected && mounts.has("workspace"),
    subscribe: (receive: () => void) => {
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    },
  };
}
