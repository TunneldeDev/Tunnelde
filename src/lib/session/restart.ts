import i18n from "@/i18n/i18n";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { prepareWindowReload } from "./reload";
import { flushEditorDrafts } from "@/lib/editor/recovery/persistence";

export type ApplicationAction = "reload" | "restart";

export function requestApplicationAction(action: ApplicationAction): void {
  const editors = useEditors.getState();
  const dirty = Object.values(editors.entries).filter((entry) => editors.isDirty(entry.tabId));
  const recovery = useSettings.getState().settings.editorDraftRecovery;
  const warning = i18n.t(
    action === "restart"
      ? recovery
        ? "restart.restartRecoveryWarning"
        : "restart.restartWarning"
      : recovery
        ? "restart.reloadRecoveryWarning"
        : "restart.reloadWarning",
  );
  const body = dirty.length
    ? `${warning}\n\n${i18n.t("restart.unsaved", { names: dirty.map((entry) => entry.name).join(", ") })}`
    : warning;
  useDialogs.getState().confirm({
    title: i18n.t(action === "restart" ? "restart.confirmTitle" : "restart.reloadTitle"),
    body,
    confirmLabel: i18n.t(action === "restart" ? "restart.command" : "restart.reload"),
    danger: dirty.length > 0,
    onConfirm: async () => {
      try {
        await flushEditorDrafts();
        if (action === "reload") {
          await prepareWindowReload();
          window.location.reload();
        } else if (isTauri()) await api.appRestart();
        else throw new Error(i18n.t("restart.nativeOnly"));
      } catch (error) {
        toast(translateError(error), "error");
      }
    },
  });
}
