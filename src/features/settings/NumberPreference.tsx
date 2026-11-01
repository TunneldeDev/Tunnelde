// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/form/Field";

interface NumberPreferenceProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  disabled?: boolean;
  descriptionId?: string;
  unit?: string;
  onChange: (value: number) => void;
}
/** Keep incomplete input local; only a complete valid value becomes a preference. */
export function NumberPreference({
  value,
  min,
  max,
  step = 1,
  label,
  disabled,
  descriptionId,
  unit,
  onChange,
}: NumberPreferenceProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [sourceValue, setSourceValue] = useState(value);
  if (sourceValue !== value) {
    setSourceValue(value);
    setDraft(null);
    setInvalid(false);
  }
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft);
    const validPrecision =
      step >= 1 ? Number.isInteger(next) : Math.abs(next * 10 - Math.round(next * 10)) < 0.00001;
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
