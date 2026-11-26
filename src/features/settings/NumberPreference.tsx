import { useId } from "react";
import { useLocalControlState, type SettingsControlState } from "./components/controlState";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/form/Field";

interface NumberPreferenceProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  integerScale?: number;
  label: string;
  disabled?: boolean;
  descriptionId?: string;
  unit?: string;
  onChange: (value: number) => void;
  useViewState?: SettingsControlState;
  stateKey?: string;
}
/** Keep incomplete input local; only a complete valid value becomes a preference. */
export function NumberPreference({
  value,
  min,
  max,
  step = 1,
  integerScale,
  label,
  disabled,
  descriptionId,
  unit,
  onChange,
  useViewState = useLocalControlState,
  stateKey = `settings:number:${label}`,
}: NumberPreferenceProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [draft, setDraft] = useViewState<string | null>(`${stateKey}:draft`, null);
  const [invalid, setInvalid] = useViewState(`${stateKey}:invalid`, false);
  const [sourceValue, setSourceValue] = useViewState(`${stateKey}:source`, value);
  if (sourceValue !== value) {
    setSourceValue(value);
    setDraft(null);
    setInvalid(false);
  }
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft);
    const validPrecision =
      integerScale !== undefined
        ? Math.abs(next * integerScale - Math.round(next * integerScale)) < 0.00001
        : step >= 1
          ? Number.isInteger(next)
          : Math.abs(next * 10 - Math.round(next * 10)) < 0.00001;
    if (!draft.trim() || !Number.isFinite(next) || next < min || next > max || !validPrecision) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    if (next !== value) onChange(next);
  };
  return (
    <div className="settings-number">
      <div className="settings-number__input">
        <Input
          type="number"
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={
            [descriptionId, invalid ? errorId : undefined].filter(Boolean).join(" ") || undefined
          }
          value={draft ?? String(value)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
              setInvalid(false);
            }
          }}
        />
        {unit ? <span aria-hidden="true">{unit}</span> : null}
      </div>
      {invalid ? (
        <span id={errorId} role="alert" className="settings-number__error">
          {t("settings.numberInvalid", { min, max })}
        </span>
      ) : null}
    </div>
  );
}
