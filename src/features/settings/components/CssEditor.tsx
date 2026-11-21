import type { ComponentProps } from "react";
import { api, isTauri } from "@/lib/api/ipc";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { CssEditorView } from "./CssEditorView";
export function CssEditor(props: Omit<ComponentProps<typeof CssEditorView>, "value" | "services">) {
  const value = useSettings((state) => state.settings.userCss);
  const update = useSettings((state) => state.update);
  return (
    <CssEditorView
      {...props}
      value={value}
      services={{
        update,
        importFile: () => api.importCss(),
        exportFile: (text) => api.exportCss(text),
        notify: toast,
        canTransferFiles: isTauri(),
      }}
    />
  );
}
