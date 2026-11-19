import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/text/format";

export interface FieldProps {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cn("td-field", error && "has-error", className)}>
      {label ? (
        <label className="td-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="td-field__error">{error}</p>
      ) : hint ? (
        <p className="td-field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("td-input", className)} {...rest} />;
}

export function Textarea({
  className,
  rows = 3,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("td-input", "td-textarea", className)} rows={rows} {...rest} />;
}

// Keep existing imports compatible; new controls live in their own shared module.
export { Switch, type SwitchProps } from "./Switch";
