import i18n from "@/i18n/i18n";
import { api, isTauri } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";

/** Writes text to the system clipboard and reports the outcome. */
export function copyText(value: string): void {
  void writeText(value);
}

async function writeText(value: string) {
  try {
    if (isTauri()) await api.clipboardWriteText(value);
    else await navigator.clipboard.writeText(value);
    toast(i18n.t("menu.copied"), "success");
  } catch {
    toast(i18n.t("menu.copyFailed"), "error");
  }
}
