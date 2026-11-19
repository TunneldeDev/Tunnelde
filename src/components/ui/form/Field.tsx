import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { HelpHint, useHelpPresentation, type HelpPresentation } from "./HelpHint";

import { cn } from "@/lib/text/format";

export interface FieldProps {
  label?: string;
  hint?: ReactNode;
  hintPresentation?: HelpPresentation;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  hintPresentation,
  error,
  htmlFor,
  className,
  children,
}: FieldProps) {
  const compact = useHelpPresentation(hintPresentation) === "tooltip";
  return (
    <div className={cn("td-field", error && "has-error", className)}>
      {label ? (
        <div className="td-field__heading">
          <label className="td-field__label" htmlFor={htmlFor}>
            {label}
          </label>
          {hint && compact ? <HelpHint label={label}>{hint}</HelpHint> : null}
        </div>
      ) : null}
      {children}
      {error ? (
        <p className="td-field__error">{error}</p>
      ) : hint && (!compact || !label) ? (
        <p className="td-field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
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
