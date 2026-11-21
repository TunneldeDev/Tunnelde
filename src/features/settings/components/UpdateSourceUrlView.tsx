import { RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import type { Settings, SettingsPatch } from "@/lib/api/types";
import { validUpdateSource } from "@/lib/updates/sourceValidation";
import { useLocalControlState, type SettingsControlState } from "./controlState";

export function UpdateSourceUrlView({
  value,
  source,
  saving,
  updatesBusy,
  onReset,
  update,
  useViewState = useLocalControlState,
}: {
  value: string;
  source: Settings["updateSource"];
  saving: boolean;
  updatesBusy: boolean;
  onReset(): void;
  update(patch: SettingsPatch): Promise<boolean>;
  useViewState?: SettingsControlState;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useViewState<string | null>("settings:updateSourceUrl:draft", null);
  const [applying, setApplying] = useState(false);
  const text = draft ?? value;
  const disabled = source !== "custom" || updatesBusy;
  const valid = validUpdateSource(text);
  const dirty = text !== value;
  const apply = async () => {
    if (!valid || !dirty || applying) return;
    const submitted = text;
    setApplying(true);
    try {
      if (await update({ updateSourceUrl: submitted })) {
        setDraft((current) => (current === submitted ? null : current));
      }
    } finally {
      setApplying(false);
    }
  };
  return (
    <div
      className={`settings-row settings-update-source${disabled ? " is-disabled" : ""}`}
      data-setting="updateSourceUrl"
    >
      <div className="settings-row__text">
        <label className="settings-row__label" htmlFor={id}>
          {t("updates.sourceUrl")}
        </label>
        <p className="settings-row__hint" id={`${id}-hint`}>
          {t("updates.sourceUrlHint")}
        </p>
      </div>
      <div className="settings-update-source__editor">
        <div className="settings-update-source__input">
          <Input
            id={id}
            type="url"
            value={text}
            disabled={disabled || applying}
            aria-describedby={`${id}-hint`}
            aria-invalid={!disabled && Boolean(text) && !valid}
            placeholder="https://updates.example.com/{channel}/latest.json"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void apply();
              }
              if (event.key === "Escape") setDraft(null);
            }}
          />
          <Button
            size="sm"
            disabled={disabled || !valid || !dirty || applying || saving}
            onClick={() => void apply()}
          >
            {t("common.apply")}
          </Button>
          <IconButton
            size="sm"
            label={t("settings.restoreOne", { name: t("updates.sourceUrl") })}
            disabled={updatesBusy || (!value && !draft)}
            onClick={() => {
              setDraft(null);
              onReset();
            }}
          >
            <RotateCcw size={13} />
          </IconButton>
        </div>
        {!disabled && text && !valid ? (
          <p role="alert" className="settings-message is-error">
            {t("updates.invalidSource")}
          </p>
        ) : null}
        {!disabled && dirty && valid ? (
          <p className="settings-row__hint" role="status">
            {t("updates.sourceDraft")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
