import { create } from "zustand";
import { useWorkspace } from "@/store/workspace";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
/** Main-only path -> opaque identity map. Native still independently admits IDs. */
export const useEditorWindowRegistrations = create<{ entries: ReadonlyMap<string, string> }>(
  () => ({ entries: new Map() }),
);
export function editorWindowIds() {
  const state = useEditorWindowRegistrations.getState();
  const tabs = useWorkspace.getState().tabs.filter((t) => t.kind === "editor");
  const entries = new Map(state.entries);
  let changed = false;
  for (const tab of tabs)
    if (!entries.has(tab.id)) {
      entries.set(tab.id, `editor-view:${crypto.randomUUID()}`);
      changed = true;
    }
  for (const id of entries.keys())
    if (!tabs.some((t) => t.id === id)) {
      entries.delete(id);
      changed = true;
    }
  if (changed) useEditorWindowRegistrations.setState({ entries });
  return [...entries.values()];
}
export const editorWindowPanelId = (tabId: string) =>
  useEditorWindowRegistrations.getState().entries.get(tabId);
export const editorWindowTabId = (panelId: string) =>
  [...useEditorWindowRegistrations.getState().entries].find(([, id]) => id === panelId)?.[0];
export const canonicalWorkspacePanelId = (id: string) => editorWindowPanelId(id) ?? id;
export const bindEditorWindow = (client: PanelWindowClient, panelId: string) => {
  if (!editorWindowTabId(panelId)) throw new Error("panel.window.staleOwner");
  return client.control<PanelLease>({
    action: "bindEditorPage",
    panelId,
  });
};
