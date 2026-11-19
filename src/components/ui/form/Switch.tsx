import { useId, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/text/format";
import "./switch.css";
import { HelpHint, useHelpPresentation, type HelpPresentation } from "./HelpHint";

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "onClick" | "children" | "role" | "aria-checked" | "aria-label" | "aria-describedby"
> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  descriptionId?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Controlled native button: keep keyboard behavior and a stable track in every flex row. */
export function Switch({
  checked,
  onChange,
  label,
  descriptionId,
  className,
  ref,
  ...rest
}: SwitchProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={descriptionId}
      className={cn("td-switch", checked && "is-on", className)}
      onClick={() => onChange(!checked)}
    >
      <span className="td-switch__thumb" aria-hidden="true" />
    </button>
  );
}

export interface SwitchRowProps extends SwitchProps {
  hint?: ReactNode;
  hintPresentation?: HelpPresentation;
  rowClassName?: string;
}

/** Text takes the available space and wraps; the control never competes for its width. */
export function SwitchRow({
  hint,
  hintPresentation,
  rowClassName,
  id,
  descriptionId,
  ...props
}: SwitchRowProps) {
  const compact = useHelpPresentation(hintPresentation) === "tooltip";
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint && !compact ? `${generatedId}-hint` : undefined;
  return (
    <div className={cn("td-switch-row", rowClassName)}>
      <div className="td-switch-row__text">
        <div className="td-switch-row__heading">
          <label className="td-switch-row__label" htmlFor={controlId}>
            {props.label}
          </label>
          {hint && compact ? <HelpHint label={props.label}>{hint}</HelpHint> : null}
        </div>
        {hint && !compact ? (
          <p id={hintId} className="td-switch-row__hint">
            {hint}
          </p>
        ) : null}
      </div>
      <Switch
        {...props}
        id={controlId}
        descriptionId={[descriptionId, hintId].filter(Boolean).join(" ") || undefined}
      />
    </div>
  );
}
