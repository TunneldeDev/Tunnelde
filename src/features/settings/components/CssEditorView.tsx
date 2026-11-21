import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { FileCode2 } from "lucide-react";
import { Textarea } from "@/components/ui/form/Field";
import { Button } from "@/components/ui/form/Button";
import { translateError } from "@/lib/api/errors";
import { validateUserCss } from "@/lib/prefs/appearance";
import type { SettingsPatch } from "@/lib/api/types";

export interface CssEditorServices {
  update(patch: SettingsPatch): Promise<boolean>;
  importFile(): Promise<string | null>;
  exportFile(text: string): Promise<string | null>;
  notify(message: string, kind: "error" | "success"): void;
  canTransferFiles: boolean;
}
export function CssEditorView({
  draft,
  value,
  services,
  onDraft,
}: {
  draft: string | null;
  value: string;
  services: CssEditorServices;
  onDraft: Dispatch<SetStateAction<string | null>>;
}) {
  const { t } = useTranslation();
  const { update } = services;
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? value;
  const apply = async () => {
    if (applying) return;
    const submitted = text;
    if (!validateUserCss(submitted).ok) {
      setError(t("settings.cssRejected"));
      return;
    }
    setApplying(true);
    try {
      if (await update({ userCss: submitted })) {
        onDraft((current) => (current === submitted ? null : current));
        setError(null);
      }
    } finally {
      setApplying(false);
    }
  };
  const importFile = async () => {
    try {
      const imported = await services.importFile();
      if (imported !== null) {
        onDraft(imported);
        setError(null);
      }
    } catch (failure) {
      services.notify(translateError(failure), "error");
    }
  };
  const exportFile = async () => {
    try {
      const path = await services.exportFile(text);
      if (path) services.notify(t("toast.cssExported", { path }), "success");
    } catch (failure) {
      services.notify(translateError(failure), "error");
    }
  };
  return (
    <div className="settings-css-editor">
      <Textarea
        aria-label={t("settings.customCss")}
        className="settings-css td-code-editor"
        spellCheck={false}
        rows={10}
        value={text}
        placeholder={t("settings.customCssPlaceholder")}
        onChange={(event) => {
          onDraft(event.target.value);
          setError(null);
        }}
      />
      {draft !== null && draft !== value ? (
        <p className="settings-row__hint" role="status">
          {t("settings.cssDraft")}
        </p>
      ) : null}
      {error ? (
        <p className="settings-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-actions">
        <Button
          variant="primary"
          disabled={applying || text === value}
          onClick={() => void apply()}
        >
          {t("common.apply")}
        </Button>
        <Button
          leading={<FileCode2 size={14} />}
          disabled={!services.canTransferFiles}
          onClick={() => void importFile()}
        >
          {t("common.import")}
        </Button>
        <Button
          variant="ghost"
          disabled={!services.canTransferFiles}
          onClick={() => void exportFile()}
        >
          {t("common.export")}
        </Button>
        {draft !== null ? (
          <Button
            variant="ghost"
            onClick={() => {
              onDraft(null);
              setError(null);
            }}
          >
            {t("settings.discardDraft")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
