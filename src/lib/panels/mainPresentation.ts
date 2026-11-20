import { usePanelWindows } from "@/store/panelWindows";
import { useFilePreview } from "@/store/filePreview";
import { panelSnapshot, requirePanel } from "./snapshot";
import { subscribePanels } from "./observation";
import { closePanel, revealPanel, setPanelLocation } from "./controller";
import type { SourcePanelPresentation } from "./sourcePresentation";

/** Main-document adapter. Never use this to read or mutate a satellite's slot;
 * the native source router must select the exact current document first. */
export function createMainPanelPresentation(): SourcePanelPresentation {
  const local = (id: string) => {
    const state = usePanelWindows.getState();
    if (
      state.available &&
      !state.snapshot.panels.some((panel) => panel.panelId === id && panel.windowId === "main")
    )
      throw new Error("panel.window.staleOwner");
    return requirePanel(id);
  };
  const read = () => {
    const state = usePanelWindows.getState();
    return panelSnapshot().filter(
      (panel) =>
        !state.available ||
        state.snapshot.panels.some(
          (lease) => lease.panelId === panel.id && lease.windowId === "main",
        ),
    );
  };
  return {
    read,
    set(id, presentation) {
      const view = local(id);
      if (!["sidebar", "workspace", "floating"].includes(presentation))
        throw new Error("panel.window.unsupportedPresentation");
      if (view === "filePreview" && useFilePreview.getState().presentation === "quickLook")
        useFilePreview.getState().dock();
      setPanelLocation(view, presentation);
      return read().find((panel) => panel.id === id)!;
    },
    close: (id) => closePanel(local(id)),
    reveal: (id) => revealPanel(local(id)),
    subscribe: (changed) => {
      const stop = subscribePanels(changed);
      const stopWindows = usePanelWindows.subscribe(changed);
      return () => {
        stop();
        stopWindows();
      };
    },
  };
}
