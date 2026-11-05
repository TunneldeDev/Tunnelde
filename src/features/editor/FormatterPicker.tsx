import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { runEditorPlugin, useFormatting } from "@/lib/plugins/formatting";

export function FormatterPicker() {
  const { t } = useTranslation();
  const picker = useFormatting((state) => state.picker);
  if (!picker) return null;
  return (
    <Dialog
      open
      title={t("editor.chooseFormatter")}
      closeLabel={t("common.close")}
      onClose={() => useFormatting.setState({ picker: null })}
    >
      <div style={{ display: "grid", gap: 8 }}>
        {picker.providers.map((provider) => (
          <Button
            key={`${provider.id}:${provider.command}`}
            onClick={() => {
              useFormatting.setState({ picker: null });
              void runEditorPlugin(provider, picker.document);
            }}
          >
            {provider.title}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
