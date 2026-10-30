// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

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
        editors.discard(tab.id);
        workspace.close(tab.id);
      },
    });
    return;
  }

  if (tab.kind === "editor") {
    editors.discard(tab.id);
  }
  workspace.close(tab.id);
}
