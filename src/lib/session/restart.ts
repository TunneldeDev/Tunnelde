import i18n from "@/i18n/i18n";
import { api, isTauri } from "@/lib/api/ipc";
import { presentError } from "@/lib/api/errors";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { prepareWindowReload } from "./reload";
import { checkpointEditorDrafts } from "@/lib/editor/recovery/checkpoint";

export type ApplicationAction = "reload" | "restart" | "quit";

const actionLabels = {
  reload: { title: "restart.reloadTitle", label: "restart.reload" },
  restart: { title: "restart.confirmTitle", label: "restart.command" },
  quit: { title: "restart.quitTitle", label: "restart.quit" },
} as const;

export function requestApplicationAction(
  action: ApplicationAction,
  finishNativeRequest?: () => Promise<void>,
): void {
  const editors = useEditors.getState();
  const dirty = Object.values(editors.entries).filter((entry) => editors.isDirty(entry.tabId));
  const recovery = useSettings.getState().settings.editorDraftRecovery;
  const warning = i18n.t(`restart.${action}${recovery ? "RecoveryWarning" : "Warning"}`);
  const body = dirty.length
    ? `${warning}\n\n${i18n.t("restart.unsaved", { names: dirty.map((entry) => entry.name).join(", ") })}`
    : warning;
  useDialogs.getState().confirm({
    title: i18n.t(actionLabels[action].title),
    body,
    confirmLabel: i18n.t(actionLabels[action].label),
    danger: dirty.length > 0,
    onConfirm: async () => {
      try {
        if (!(await checkpointEditorDrafts())) return;
        if (finishNativeRequest) {
          await finishNativeRequest();
        } else if (action === "reload") {
          await prepareWindowReload();
          window.location.reload();
        } else if (action === "restart" && isTauri()) await api.appRestart();
        else throw new Error(i18n.t("restart.nativeOnly"));
      } catch (error) {
        toast(presentError(error), "error");
      }
    },
  });
}
