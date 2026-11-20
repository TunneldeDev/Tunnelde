import i18n from "@/i18n/i18n";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

/** Closes a tab, asking first when it is an editor with unsaved changes. */
export function closeTab(tab: WorkspaceTab): void {
  const editors = useEditors.getState();
  const workspace = useWorkspace.getState();

  if (tab.kind === "editor" && editors.isDirty(tab.id)) {
    useDialogs.getState().confirm({
      title: i18n.t("editor.discardTitle"),
      body: i18n.t("editor.discardBody", { name: tab.title }),
      confirmLabel: i18n.t("editor.discard"),
      danger: true,
      onConfirm: () => {
        workspace.close(tab.id);
        editors.discard(tab.id);
      },
    });
    return;
  }

  // Workspace close samples the live session before an editor is discarded.
  workspace.close(tab.id);
  if (tab.kind === "editor") editors.discard(tab.id);
}
