/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

export interface UiSearchPreset {
  /** Host search syntax always requires @field:value; metadata uses bare field names. */
  key: string;
  value: string;
  label: string;
  exclusive?: boolean;
  separatorBefore?: boolean;
}
export interface UiSearchFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "size"
> {
  value: string;
  onChange: (value: string) => void;
  presets?: readonly UiSearchPreset[];
  inputRef?: React.Ref<HTMLInputElement>;
  inputClassName?: string;
  filterLabel?: string;
  filterKeys?: readonly string[];
}
