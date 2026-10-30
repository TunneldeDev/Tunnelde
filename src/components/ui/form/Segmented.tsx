// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Minus, Plus } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { ACCENT_SWATCHES } from "@/lib/prefs/defaults";
import { cn } from "@/lib/text/format";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>) {
  return (
    <div className="td-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={cn("td-segmented__item", option.value === value && "is-active")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface StepperProps {
  value: number;
  min: number;
  max: number;
  label: string;
  suffix?: string;
  onChange: (value: number) => void;
}

export function Stepper({ value, min, max, label, suffix, onChange }: StepperProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <div className="td-stepper" role="group" aria-label={label}>
      <IconButton
        size="sm"
        label="-"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Minus size={12} />
      </IconButton>
      <span className="td-stepper__value">
        {value}
        {suffix ? <span className="td-stepper__suffix">{suffix}</span> : null}
      </span>
      <IconButton
        size="sm"
        label="+"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Plus size={12} />
      </IconButton>
    </div>
  );
}

interface SwatchPickerProps {
  value: string;
  onChange: (id: string) => void;
}

export function SwatchPicker({ value, onChange }: SwatchPickerProps) {
  const { t } = useTranslation();
  return (
    <div className="td-swatches" role="radiogroup" aria-label={t("settings.accent")}>
      {ACCENT_SWATCHES.map((swatch) => (
        <button
          key={swatch.id}
          type="button"
          role="radio"
          aria-checked={value === swatch.id}
          aria-label={t(swatch.labelKey)}
          title={t(swatch.labelKey)}
          className={cn("td-swatch", value === swatch.id && "is-active")}
          style={{ "--td-swatch": swatch.color } as CSSProperties}
          onClick={() => onChange(swatch.id)}
        />
      ))}
    </div>
  );
}
