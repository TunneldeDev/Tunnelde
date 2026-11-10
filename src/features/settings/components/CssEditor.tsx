import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { FileCode2 } from "lucide-react";
import { Textarea } from "@/components/ui/form/Field";
import { Button } from "@/components/ui/form/Button";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { validateUserCss } from "@/lib/prefs/appearance";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";

export function CssEditor({
  draft,
  onDraft,
}: {
  draft: string | null;
  onDraft: Dispatch<SetStateAction<string | null>>;
}) {
  const { t } = useTranslation();
  const value = useSettings((state) => state.settings.userCss);
  const update = useSettings((state) => state.update);
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
      const imported = await api.importCss();
      if (imported !== null) {
        onDraft(imported);
        setError(null);
      }
    } catch (failure) {
      toast(translateError(failure), "error");
    }
  };
  const exportFile = async () => {
    try {
      const path = await api.exportCss(text);
      if (path) toast(t("toast.cssExported", { path }), "success");
    } catch (failure) {
      toast(translateError(failure), "error");
    }
  };
  return (
    <div className="settings-css-editor">
      <Textarea
        aria-label={t("settings.customCss")}
        className="settings-css"
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
          disabled={!isTauri()}
          onClick={() => void importFile()}
        >
          {t("common.import")}
        </Button>
        <Button variant="ghost" disabled={!isTauri()} onClick={() => void exportFile()}>
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
