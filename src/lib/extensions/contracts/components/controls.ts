/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

export interface UiButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "ghost-danger" | "danger";
  size?: "sm" | "md";
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}
export interface UiIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: "sm" | "md";
  ref?: React.Ref<HTMLButtonElement>;
}
export interface UiFieldProps {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}
export interface UiSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  descriptionId?: string;
}
